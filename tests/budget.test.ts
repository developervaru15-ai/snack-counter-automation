import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { State } from "../src/models.js";
import { CurrencyMismatch, FxRates, MissingRate, Money } from "../src/money.js";
import { render } from "../src/reporting.js";
import { BudgetBlocked, ValidationError } from "../src/service.js";
import { BLR, NOV, OSLO, completeRefill, spendAlready, world } from "./helpers.js";

describe("money rules", () => {
  it("never mixes currencies silently", () => {
    assert.throws(() => Money.of(1, "NOK").add(Money.of(1, "INR")), CurrencyMismatch);
    assert.throws(() => Money.of(1, "NOK").lt(Money.of(1, "INR")), CurrencyMismatch);
  });

  it("uses exact decimal arithmetic", () => {
    assert.equal(Money.of("0.10", "NOK").add(Money.of("0.20", "NOK")).minor, 30);   // not 0.30000000000000004
    assert.throws(() => Money.of(0.1, "NOK"), TypeError);
  });

  it("rounds half up when parsing", () => {
    assert.equal(Money.of("1.005", "NOK").minor, 101);
    assert.equal(Money.of("12.5", "NOK").minor, 1250);
  });

  it("formats amounts with thousands separators", () => {
    assert.equal(String(Money.of(2700, "NOK")), "2,700.00 NOK");
    assert.equal(String(Money.of(-300, "NOK")), "-300.00 NOK");
  });

  it("reports a missing rate instead of guessing", () => {
    assert.throws(() => new FxRates("NOK", []).convert(Money.of(100, "INR"), NOV), MissingRate);
  });
});

describe("budget check", () => {
  it("reserves on commit and swaps the reservation for the real amount on receipt", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(6000 - 1200, "NOK"));
    svc.submitReceipt(r.id, r.assignee!, Money.of(700, "NOK"), "r.jpg");
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), Money.zero("NOK"));
    assert.deepEqual(svc.budget.spent("Oslo", NOV), Money.of(700, "NOK"));
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(5300, "NOK"));
  });

  it("shrinks the spending cap to whatever is left", () => {
    const { svc } = world();
    spendAlready(svc, OSLO, NOV, 5300);                          // 700 NOK left, less than the 1200 cap
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    assert.deepEqual(r.cap, Money.of(700, "NOK"));
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.zero("NOK"));
  });

  it("asks no one when the budget cannot fund a minimum refill", () => {
    const { svc, chat } = world();
    spendAlready(svc, OSLO, NOV, 5800);                          // 200 left, minimum purchase is 300
    const r = svc.reportEmpty("Oslo", "x");
    assert.deepEqual([r.state, r.assignee], [State.BLOCKED_BUDGET, null]);
    assert.equal(chat.dmsTo("mgr-oslo").length, 1);

    svc.tick();                                                  // still blocked, and the manager is not nagged
    assert.equal(chat.dmsTo("mgr-oslo").length, 1);

    svc.addBudget("Oslo", NOV, Money.of(1000, "NOK"), "mgr-oslo");
    assert.equal(r.state, State.OFFERED);
  });

  it("blocks an accept when the budget ran out between offer and accept", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    spendAlready(svc, OSLO, NOV, 5900);
    assert.throws(() => svc.accept(r.id, r.assignee!), BudgetBlocked);
    assert.equal(r.state, State.BLOCKED_BUDGET);
  });

  it("gives reserved money back after a missed deadline", () => {
    const { svc, clock } = world();
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    clock.advance({ hours: 25 });
    svc.tick();
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(6000, "NOK"));
  });

  it("pays, flags and counts an overspend of the cap", () => {
    const { svc, chat } = world();
    spendAlready(svc, OSLO, NOV, 4800);                          // 1200 left, so the cap is 1200
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    svc.submitReceipt(r.id, r.assignee!, Money.of(1500, "NOK"), "r.jpg");
    assert.equal(r.overCap, true);
    assert.equal(r.state, State.CLAIMED);                        // the volunteer is not left out of pocket
    assert.ok(chat.dmsTo("mgr-oslo").length > 0);
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(-300, "NOK"));
    assert.equal(svc.reportEmpty("Oslo", "x").state, State.BLOCKED_BUDGET);   // and the next one waits
  });

  it("keeps a separate budget per office, in its own currency", () => {
    const { svc } = world();
    completeRefill(svc, OSLO, 1000);
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(5000, "NOK"));
    assert.deepEqual(svc.budget.remaining("Bengaluru", NOV), Money.of(15000, "INR"));
  });

  it("refuses a receipt in the wrong currency", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    assert.throws(() => svc.submitReceipt(r.id, r.assignee!, Money.of(500, "INR"), "r.jpg"), ValidationError);
  });

  it("budgets per month, following the purchase date", () => {
    // Committed Fri 30 Oct, bought Mon 2 Nov: reserved in October, spent in November.
    const { svc, clock } = world({ start: new Date(Date.UTC(2026, 9, 30, 9, 0)) });
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    assert.deepEqual(svc.budget.reserved("Oslo", "2026-10"), Money.of(1200, "NOK"));
    clock.advance({ days: 2, hours: 23, minutes: 30 });          // Mon 2 Nov, 09:30 Oslo, before the deadline
    svc.submitReceipt(r.id, r.assignee!, Money.of(800, "NOK"), "r.jpg");
    assert.deepEqual(svc.budget.reserved("Oslo", "2026-10"), Money.zero("NOK"));
    assert.deepEqual(svc.budget.spent("Oslo", "2026-10"), Money.zero("NOK"));
    assert.deepEqual(svc.budget.spent("Oslo", NOV), Money.of(800, "NOK"));
    assert.deepEqual(svc.budget.remaining("Oslo", NOV), Money.of(5200, "NOK"));
  });
});

describe("monthly report", () => {
  it("totals across both offices and currencies", () => {
    const { svc } = world();
    const oslo: Array<[number, Record<string, number>]> = [[500, { chips: 10 }], [700, { nuts: 5, chips: 4 }], [1000, { fruit: 20 }]];
    const blr: Array<[number, Record<string, number>]> = [[1500, { chips: 8 }], [2500, { namkeen: 12 }]];
    for (const [amount, items] of oslo) completeRefill(svc, OSLO, amount, items);
    for (const [amount, items] of blr) completeRefill(svc, BLR, amount, items);

    const fx = new FxRates("NOK", [[NOV, "INR", "0.125"]]);      // 1 INR = 0.125 NOK
    const rep = svc.monthlyReport(NOV, fx);
    const [osloLine, blrLine] = rep.offices;

    assert.deepEqual(osloLine!.spent, Money.of(2200, "NOK"));
    assert.deepEqual(blrLine!.spent, Money.of(4000, "INR"));
    assert.deepEqual(osloLine!.remaining, Money.of(3800, "NOK"));
    assert.deepEqual(blrLine!.remaining, Money.of(11000, "INR"));
    assert.deepEqual([osloLine!.purchases, blrLine!.purchases], [3, 2]);
    assert.deepEqual(blrLine!.spentInReportingCurrency, Money.of(500, "NOK"));
    assert.deepEqual(rep.totalSpent, Money.of(2700, "NOK"));     // 2200 NOK + 4000 INR x 0.125
    assert.deepEqual(rep.items.slice(0, 2), [["chips", 22], ["fruit", 20]]);   // most bought, both offices
    assert.match(render(rep), /Total: 2,700\.00 NOK/);
  });

  it("does not mix in other months", () => {
    const { svc } = world();
    completeRefill(svc, OSLO, 900);
    const rep = svc.monthlyReport("2026-12", new FxRates("NOK", [["2026-12", "INR", "0.125"]]));
    assert.deepEqual(rep.totalSpent, Money.zero("NOK"));
  });
});
