/** Shared test setup: the two real offices, realistic volunteer pools, a fake clock. */
import { FakeChat, FakeClock, FakeHR } from "../src/fakes.js";
import { Office, Policy, State, Volunteer } from "../src/models.js";
import { Money } from "../src/money.js";
import { SnackService } from "../src/service.js";

export const OSLO: Office = {
  name: "Oslo", currency: "NOK", tz: "Europe/Oslo", monthlyBudget: Money.of(6000, "NOK"),
  minPurchase: Money.of(300, "NOK"), maxPurchase: Money.of(1200, "NOK"), managerId: "mgr-oslo",
};

export const BLR: Office = {
  name: "Bengaluru", currency: "INR", tz: "Asia/Kolkata", monthlyBudget: Money.of(15000, "INR"),
  minPurchase: Money.of(500, "INR"), maxPurchase: Money.of(3000, "INR"), managerId: "mgr-blr",
};

// Monday 2 Nov 2026, 10:00 in Oslo and 14:30 in Bengaluru: inside office hours in both.
export const MON_10_OSLO = new Date(Date.UTC(2026, 10, 2, 9, 0));

export const NOV = "2026-11";

/** About 15 in Oslo and 20 in Bengaluru, all in the office Monday to Friday. */
export function volunteers(): Volunteer[] {
  const pad = (i: number) => String(i).padStart(2, "0");
  return [
    ...Array.from({ length: 15 }, (_, i) => new Volunteer(`o${pad(i + 1)}`, `Oslo ${i + 1}`, "Oslo", "NOK")),
    ...Array.from({ length: 20 }, (_, i) => new Volunteer(`b${pad(i + 1)}`, `Blr ${i + 1}`, "Bengaluru", "INR")),
  ];
}

export interface WorldOptions {
  policy?: Partial<Policy>;
  vols?: Volunteer[];
  start?: Date;
  approvalDays?: number;
}

export function world(opts: WorldOptions = {}) {
  const clock = new FakeClock(opts.start ?? MON_10_OSLO);
  const chat = new FakeChat();
  const hr = new FakeHR(clock, opts.approvalDays ?? 3);
  const svc = new SnackService([OSLO, BLR], opts.vols ?? volunteers(), chat, hr, clock, opts.policy);
  return { svc, clock, chat, hr };
}

export type World = ReturnType<typeof world>;

/** Drive one refill from 'empty' to 'claim filed' with whoever the chooser picks. */
export function completeRefill(svc: SnackService, office: Office, amount: number, items: Record<string, number> = {}) {
  const r = svc.reportEmpty(office.name, "anyone");
  if (r.state !== State.OFFERED) throw new Error(`expected OFFERED, got ${r.state}`);
  svc.accept(r.id, r.assignee!);
  return svc.submitReceipt(r.id, r.assignee!, Money.of(amount, office.currency), "receipt.jpg", items);
}

/** Seed the ledger as if earlier purchases this month had happened. */
export function spendAlready(svc: SnackService, office: Office, month: string, amount: number): void {
  svc.budget.spend("seed", office.name, month, Money.of(amount, office.currency));
}
