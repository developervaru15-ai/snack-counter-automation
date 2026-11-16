import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Stats, NO_STATS, rankCandidates } from "../src/assign.js";
import { Visit, Volunteer, VolunteerOptions } from "../src/models.js";
import { Money } from "../src/money.js";
import { addBusinessHours, formatLocal, localParts } from "../src/timeutil.js";
import { OSLO, world } from "./helpers.js";

const vol = (id: string, office = "Oslo", opts: VolunteerOptions = {}) =>
  new Volunteer(id, id, office, office === "Oslo" ? "NOK" : "INR", opts);

describe("ranking", () => {
  const DAYS = ["2026-11-02"];                                   // a Monday

  const ids = (vols: Volunteer[], stats: Record<string, Partial<Stats>>) =>
    rankCandidates(vols, (e) => ({ ...NO_STATS, ...stats[e] }), "Oslo", DAYS).map((v) => v.employeeId);

  it("asks the person with the least recent load first", () => {
    const stats = { a: { recentRefills: 3 }, b: { recentRefills: 1 }, c: { recentRefills: 2 } };
    assert.deepEqual(ids([vol("a"), vol("b"), vol("c")], stats), ["b", "c", "a"]);
  });

  it("asks someone still waiting for money last, whatever their history", () => {
    const stats = { a: { outstandingClaims: 1, recentRefills: 0 }, b: { recentRefills: 5 } };
    assert.deepEqual(ids([vol("a"), vol("b")], stats), ["b", "a"]);
  });

  it("breaks a tie by who refilled longest ago", () => {
    const old = new Date(Date.UTC(2026, 7, 1));
    const recent = new Date(Date.UTC(2026, 9, 1));
    const stats = { a: { lastRefill: recent }, b: { lastRefill: old } };
    assert.deepEqual(ids([vol("a"), vol("b")], stats), ["b", "a"]);
  });

  it("counts missed commitments against you", () => {
    const stats = { a: { strikes: 1 }, b: { strikes: 0 } };
    assert.deepEqual(ids([vol("a"), vol("b")], stats), ["b", "a"]);
  });

  it("always gives the same order for the same inputs", () => {
    assert.deepEqual(ids([vol("c"), vol("a"), vol("b")], {}), ["a", "b", "c"]);
  });
});

describe("availability", () => {
  it("skips people who are not in the office in time", () => {
    // Reported Tuesday 10:00; the job is due Wednesday 10:00, so only Tue/Wed matter.
    const vols = [vol("o01", "Oslo", { officeDays: [4] }),       // Fridays only
                  vol("o02", "Oslo", { officeDays: [2] })];      // Wednesdays
    const { svc } = world({ vols, start: new Date(Date.UTC(2026, 10, 3, 9, 0)) });
    assert.equal(svc.reportEmpty("Oslo", "x").assignee, "o02");
  });

  it("skips people on holiday", () => {
    const vols = [vol("o01", "Oslo", { away: [["2026-11-02", "2026-11-06"]] }), vol("o02")];
    const { svc } = world({ vols });
    assert.equal(svc.reportEmpty("Oslo", "x").assignee, "o02");
  });

  it("never asks people who opted out", () => {
    const { svc } = world({ vols: [vol("o01", "Oslo", { active: false }), vol("o02")] });
    assert.equal(svc.reportEmpty("Oslo", "x").assignee, "o02");
  });

  it("counts a visitor for the office they are in, not their home office", () => {
    const visit: Visit = { office: "Bengaluru", start: "2026-11-02", end: "2026-11-13" };
    const vols = [
      vol("a-visitor", "Oslo", { visits: [visit] }),
      vol("o02"),
      vol("b01", "Bengaluru", { away: [["2026-11-01", "2026-11-30"]] }),
    ];
    const { svc, hr } = world({ vols });

    assert.equal(svc.reportEmpty("Oslo", "x").assignee, "o02");           // visitor is away from Oslo

    const r = svc.reportEmpty("Bengaluru", "x");                          // only the visitor is around
    assert.equal(r.assignee, "a-visitor");
    svc.accept(r.id, "a-visitor");
    svc.submitReceipt(r.id, "a-visitor", Money.of(1800, "INR"), "r.jpg");
    const claim = hr.claims.get(r.claimId!)!;
    // HR gets the receipt currency; it converts to the visitor's NOK payroll itself.
    assert.deepEqual([claim.employeeId, claim.amount.currency], ["a-visitor", "INR"]);
  });

  it("shares the work instead of using the same people", () => {
    const { svc, clock } = world();
    const buyers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = svc.reportEmpty("Oslo", "x");
      svc.accept(r.id, r.assignee!);
      svc.submitReceipt(r.id, r.assignee!, Money.of(400, "NOK"), "r.jpg");
      buyers.push(r.assignee!);
      clock.advance({ days: 4 });
      svc.tick();                                                         // HR approves along the way
    }
    assert.equal(new Set(buyers).size, 4);
  });
});

describe("business hours", () => {
  it("rolls a Friday-evening deadline into Monday", () => {
    const fri17Oslo = new Date(Date.UTC(2026, 10, 6, 16, 0));
    const got = localParts(addBusinessHours(fri17Oslo, 2, OSLO.tz), OSLO.tz);
    assert.deepEqual([got.weekday, got.hour], [0, 10]);                   // Monday 10:00
  });

  it("makes one working day from Monday morning Tuesday morning", () => {
    const got = addBusinessHours(new Date(Date.UTC(2026, 10, 2, 9, 0)), 9, OSLO.tz);
    assert.equal(formatLocal(got, OSLO.tz), "Tue 10:00");
  });

  it("keeps wall-clock hours across the autumn DST change", () => {
    // Oslo clocks go back on Sun 25 Oct 2026. Fri 23 Oct 17:00 (CEST) + 2h lands on Mon 26 Oct 10:00 (CET).
    const fri17 = new Date(Date.UTC(2026, 9, 23, 15, 0));
    assert.equal(formatLocal(addBusinessHours(fri17, 2, OSLO.tz), OSLO.tz), "Mon 10:00");
  });
});
