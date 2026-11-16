import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { State } from "../src/models.js";
import { Money } from "../src/money.js";
import { AlreadyTaken, InvalidState, NotEligible, NotYourTurn } from "../src/service.js";
import { NOV, OSLO, completeRefill, world } from "./helpers.js";

describe("happy path", () => {
  it("goes from empty to reimbursed", () => {
    const { svc, clock, chat, hr } = world();
    const r = svc.reportEmpty("Oslo", "o07");
    assert.equal(r.state, State.OFFERED);
    const buyer = r.assignee!;
    assert.ok(chat.dmsTo(buyer).length > 0);                    // the buyer was asked in chat

    svc.accept(r.id, buyer);
    assert.equal(r.state, State.COMMITTED);
    svc.submitReceipt(r.id, buyer, Money.of(640, "NOK"), "receipt.jpg", { nuts: 4 });
    assert.equal(r.state, State.CLAIMED);

    const claim = hr.claims.get(r.claimId!)!;                   // exactly what HR needs
    assert.deepEqual(
      [claim.employeeId, claim.amount, claim.receiptRef],
      [buyer, Money.of(640, "NOK"), "receipt.jpg"],
    );

    clock.advance({ days: 2 });
    svc.tick();
    assert.equal(r.state, State.CLAIMED);                       // HR not done yet
    clock.advance({ days: 2 });
    svc.tick();
    assert.equal(r.state, State.REIMBURSED);
    assert.match(chat.dmsTo(buyer).at(-1)!, /approved/);
  });

  it("does not start a second refill on a second empty report", () => {
    const { svc } = world();
    const first = svc.reportEmpty("Oslo", "o07");
    const again = svc.reportEmpty("Oslo", "o09");
    assert.equal(first, again);
    assert.equal(svc.refills.size, 1);
  });

  it("keeps offices independent", () => {
    const { svc } = world();
    const a = svc.reportEmpty("Oslo", "o01");
    const b = svc.reportEmpty("Bengaluru", "b01");
    assert.notEqual(a.id, b.id);
  });
});

describe("no double commit", () => {
  it("lets only the offered volunteer accept", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const other = r.assignee !== "o02" ? "o02" : "o03";
    assert.throws(() => svc.accept(r.id, other), NotYourTurn);
    svc.accept(r.id, r.assignee!);                              // the offeree still can
  });

  it("refuses a second person once someone committed", () => {
    const { svc } = world({ policy: { maxTargetedAttempts: 0 } });   // broadcast: anyone may try
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, "o05");
    assert.throws(() => svc.accept(r.id, "o06"), AlreadyTaken);
    assert.equal(r.assignee, "o05");
  });

  it("treats a double tap by the same person as harmless", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    svc.accept(r.id, r.assignee!);
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), OSLO.maxPurchase);   // reserved once
  });

  it("gives exactly one winner when fifteen people accept at once", async () => {
    const { svc } = world({ policy: { maxTargetedAttempts: 0 } });
    const r = svc.reportEmpty("Oslo", "x");
    const outcomes: string[] = [];

    // Fifteen handlers, each resumed on a separate event-loop turn, like fifteen button taps arriving
    // together. Each accept() is synchronous, so the check and the take can never interleave.
    await Promise.all(Array.from({ length: 15 }, (_, i) => (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        svc.accept(r.id, `o${String(i + 1).padStart(2, "0")}`);
        outcomes.push("won");
      } catch (e) {
        if (!(e instanceof AlreadyTaken)) throw e;
        outcomes.push("lost");
      }
    })()));

    assert.equal(outcomes.filter((o) => o === "won").length, 1);
    assert.equal(outcomes.filter((o) => o === "lost").length, 14);
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), OSLO.maxPurchase);   // one reservation, not 15
  });

  it("refuses broadcast takers who cannot refill that office", () => {
    const { svc } = world({ policy: { maxTargetedAttempts: 0 } });
    const r = svc.reportEmpty("Oslo", "x");
    assert.throws(() => svc.accept(r.id, "b01"), NotEligible);      // works in Bengaluru, not visiting
  });
});

describe("handover", () => {
  it("passes a declined offer to someone else", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const first = r.assignee;
    svc.decline(r.id, first!);
    assert.equal(r.state, State.OFFERED);
    assert.notEqual(r.assignee, first);
  });

  it("expires an ignored offer and moves on", () => {
    const { svc, clock } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const first = r.assignee!;
    clock.advance({ hours: 4, minutes: 1 });
    svc.tick();
    assert.notEqual(r.assignee, first);
    assert.ok(r.tried.includes(first));
  });

  it("hands a refill nobody completes to someone else", () => {
    const { svc, clock, chat } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const first = r.assignee!;
    svc.accept(r.id, first);
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), OSLO.maxPurchase);

    clock.advance({ hours: 25 });                               // past the next-day deadline
    svc.tick();

    assert.equal(r.state, State.OFFERED);
    assert.notEqual(r.assignee, first);
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), Money.zero("NOK"));   // reservation given back
    assert.equal(svc.strikes.length, 1);
    assert.ok(chat.dmsTo(first).some((m) => m.includes("passed")));
  });

  it("does not count an early withdrawal as a strike", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const first = r.assignee!;
    svc.accept(r.id, first);
    svc.withdraw(r.id, first);
    assert.equal(svc.strikes.length, 0);
    assert.notEqual(r.assignee, first);
  });

  it("broadcasts to everyone after enough personal offers", () => {
    const { svc, chat } = world({ policy: { maxTargetedAttempts: 2 } });
    const r = svc.reportEmpty("Oslo", "x");
    svc.decline(r.id, r.assignee!);
    svc.decline(r.id, r.assignee!);
    assert.deepEqual([r.state, r.broadcast], [State.OPEN, true]);
    assert.equal(chat.posts.length, 1);
    svc.accept(r.id, "o15");                                    // someone who was never asked
    assert.equal(r.state, State.COMMITTED);
  });

  it("still reimburses a buyer who missed the deadline but bought anyway", () => {
    const { svc, clock, chat, hr } = world();
    const r = svc.reportEmpty("Oslo", "x");
    const first = r.assignee!;
    svc.accept(r.id, first);
    clock.advance({ hours: 25 });
    svc.tick();
    const second = r.assignee!;
    assert.notEqual(first, second);

    svc.submitReceipt(r.id, first, Money.of(500, "NOK"), "late.jpg");   // they bought after all

    assert.equal(r.state, State.CLAIMED);
    assert.equal(hr.claims.get(r.claimId!)!.employeeId, first);
    assert.ok(chat.dmsTo(second).some((m) => m.includes("already been refilled")));
    assert.throws(() => svc.accept(r.id, second), InvalidState);        // nothing left to do
  });

  it("frees the office and the budget when a refill is cancelled", () => {
    const { svc } = world();
    const r = svc.reportEmpty("Oslo", "x");
    svc.accept(r.id, r.assignee!);
    svc.cancel(r.id);
    assert.deepEqual(svc.budget.reserved("Oslo", NOV), Money.zero("NOK"));
    assert.notEqual(svc.reportEmpty("Oslo", "x").id, r.id);
  });
});

describe("HR integration", () => {
  it("neither loses nor duplicates the claim during an HR outage", () => {
    const { svc, hr } = world();
    hr.down = true;
    const r = completeRefill(svc, OSLO, 600);
    assert.equal(r.state, State.PURCHASED);
    assert.equal(hr.claims.size, 0);
    hr.down = false;
    svc.tick();
    svc.tick();
    assert.equal(r.state, State.CLAIMED);
    assert.equal(hr.claims.size, 1);
  });

  it("alerts the manager about a rejected claim", () => {
    const { svc, chat, hr } = world();
    const r = completeRefill(svc, OSLO, 600);
    hr.reject(r.claimId!);
    svc.tick();
    assert.equal(r.state, State.CLAIM_REJECTED);
    assert.ok(chat.dmsTo("mgr-oslo").length > 0);
  });

  it("chases slow claims exactly once", () => {
    const { svc, clock, chat } = world({ approvalDays: 30 });
    const r = completeRefill(svc, OSLO, 600);
    clock.advance({ days: 11 });
    svc.tick();
    svc.tick();
    assert.equal(r.state, State.CLAIMED);
    assert.equal(chat.dmsTo("mgr-oslo").length, 1);
  });
});
