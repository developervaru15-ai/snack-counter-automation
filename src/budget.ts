/**
 * Monthly budget ledger, one budget per office in that office's own currency.
 *
 * remaining = budget + adjustments - spent - reserved
 *
 *   reserved: set aside when a volunteer commits (their spending cap); released if they miss or withdraw
 *   spent:    the real receipt amount, in the month the purchase happened
 * Entries are only ever appended, so every number can be re-derived and audited.
 */
import { Office } from "./models.js";
import { Money, total } from "./money.js";

type Kind = "RESERVE" | "RELEASE" | "SPEND" | "ADJUST";

export class BudgetExceeded extends Error {}

interface Entry {
  office: string;
  month: string;     // "YYYY-MM" in the office's own time zone
  kind: Kind;
  amount: Money;
  ref: string;       // refill id, or the approver for ADJUST
}

export class BudgetLedger {
  readonly entries: Entry[] = [];
  private reservations = new Map<string, Entry>();

  constructor(private offices: Map<string, Office>) {}

  private sum(office: string, month: string, kind: Kind): Money {
    const currency = this.offices.get(office)!.currency;
    return total(
      this.entries.filter((e) => e.office === office && e.month === month && e.kind === kind).map((e) => e.amount),
      currency,
    );
  }

  budget(office: string, month: string): Money {
    return this.offices.get(office)!.monthlyBudget.add(this.sum(office, month, "ADJUST"));
  }

  spent(office: string, month: string): Money {
    return this.sum(office, month, "SPEND");
  }

  reserved(office: string, month: string): Money {
    return this.sum(office, month, "RESERVE").sub(this.sum(office, month, "RELEASE"));
  }

  remaining(office: string, month: string): Money {
    return this.budget(office, month).sub(this.spent(office, month)).sub(this.reserved(office, month));
  }

  reserve(refillId: string, office: string, month: string, amount: Money): void {
    const left = this.remaining(office, month);
    if (amount.gt(left)) throw new BudgetExceeded(`${amount} exceeds remaining ${left}`);
    const e: Entry = { office, month, kind: "RESERVE", amount, ref: refillId };
    this.entries.push(e);
    this.reservations.set(refillId, e);
  }

  /** Give back a refill's reservation. Does nothing if it has none. */
  release(refillId: string): void {
    const r = this.reservations.get(refillId);
    if (!r) return;
    this.reservations.delete(refillId);
    this.entries.push({ office: r.office, month: r.month, kind: "RELEASE", amount: r.amount, ref: refillId });
  }

  spend(refillId: string, office: string, month: string, amount: Money): void {
    this.entries.push({ office, month, kind: "SPEND", amount, ref: refillId });
  }

  addFunds(office: string, month: string, amount: Money, approver: string): void {
    this.entries.push({ office, month, kind: "ADJUST", amount, ref: approver });
  }
}
