/** Plain data: configuration (Office, Policy), people (Volunteer) and the Refill record. */
import { Money } from "./money.js";
import { LocalDate, weekdayOf } from "./timeutil.js";

export enum State {
  OPEN = "OPEN",                      // box is empty, nobody holds the job right now
  OFFERED = "OFFERED",                // one named volunteer has been asked
  COMMITTED = "COMMITTED",            // volunteer accepted; budget reserved; deadline running
  PURCHASED = "PURCHASED",            // receipt in, claim not yet accepted by HR (retry state)
  CLAIMED = "CLAIMED",                // claim filed in HR, waiting for approval
  REIMBURSED = "REIMBURSED",          // HR approved. Terminal.
  CLAIM_REJECTED = "CLAIM_REJECTED",  // HR rejected; a human must follow up. Terminal.
  BLOCKED_BUDGET = "BLOCKED_BUDGET",  // not enough monthly budget to fund even a small refill
  CANCELLED = "CANCELLED",            // false alarm. Terminal.
}

/** At most one refill per office may be in these states at a time. This is what stops double-buying. */
export const ACTIVE: ReadonlySet<State> = new Set([State.OPEN, State.OFFERED, State.COMMITTED, State.BLOCKED_BUDGET]);

export interface Office {
  name: string;
  currency: string;
  tz: string;              // IANA zone, e.g. "Europe/Oslo"
  monthlyBudget: Money;
  minPurchase: Money;      // below this much budget left, we do not ask anyone to buy
  maxPurchase: Money;      // upper end of a typical purchase; the per-refill spending cap
  managerId: string;       // budget owner: gets blocked-budget, overspend and rejected-claim alerts
}

export interface Policy {
  offerTtlHours: number;          // business hours a named volunteer has to answer
  commitTtlHours: number;         // business hours to complete once committed (about one working day)
  maxTargetedAttempts: number;    // personal offers before the job is broadcast to the whole office
  historyDays: number;            // window for "how many refills has this person done lately"
  claimChaseDays: number;         // HR is expected to take 1-10 days; alert after that
}

export const DEFAULT_POLICY: Policy = {
  offerTtlHours: 4,
  commitTtlHours: 9,
  maxTargetedAttempts: 3,
  historyDays: 90,
  claimChaseDays: 10,
};

export interface Visit {
  office: string;
  start: LocalDate;
  end: LocalDate;
}

export interface VolunteerOptions {
  officeDays?: number[];                      // weekdays they are usually in (Monday = 0)
  away?: Array<[LocalDate, LocalDate]>;       // holidays / leave, inclusive
  visits?: Visit[];                           // time at the other office
  active?: boolean;                           // opted in
}

export class Volunteer {
  readonly officeDays: number[];
  readonly away: Array<[LocalDate, LocalDate]>;
  readonly visits: Visit[];
  readonly active: boolean;

  constructor(readonly employeeId: string, readonly name: string, readonly homeOffice: string,
              readonly payrollCurrency: string, opts: VolunteerOptions = {}) {
    this.officeDays = opts.officeDays ?? [0, 1, 2, 3, 4];
    this.away = opts.away ?? [];
    this.visits = opts.visits ?? [];
    this.active = opts.active ?? true;
  }

  isAway(d: LocalDate): boolean {
    return this.away.some(([a, b]) => a <= d && d <= b);
  }

  effectiveOffice(d: LocalDate): string {
    return this.visits.find((v) => v.start <= d && d <= v.end)?.office ?? this.homeOffice;
  }

  /** Could this person physically refill `office` on date d? */
  canBeInOffice(office: string, d: LocalDate): boolean {
    if (!this.active || this.isAway(d)) return false;
    const visit = this.visits.find((v) => v.start <= d && d <= v.end);
    if (visit) return visit.office === office && weekdayOf(d) < 5;   // visitors are in on every working day
    return this.homeOffice === office && this.officeDays.includes(weekdayOf(d));
  }
}

export class Refill {
  state = State.OPEN;
  assignee: string | null = null;                 // offeree, then buyer
  offerExpiresAt: Date | null = null;
  dueAt: Date | null = null;
  broadcast = false;                              // true: any eligible volunteer may take it, first come first served
  tried: string[] = [];                           // never offer to these again for this refill
  formerAssignees = new Set<string>();            // lost a commitment by missing the deadline
  cap: Money | null = null;                       // spending cap that was reserved at commit time
  amount: Money | null = null;                    // what the receipt said
  overCap = false;
  items: Record<string, number> = {};             // {"salted peanuts": 6}: units bought
  receiptRef: string | null = null;
  purchasedAt: Date | null = null;
  claimId: string | null = null;
  claimSubmittedAt: Date | null = null;
  reimbursedAt: Date | null = null;
  chased = false;
  audit: Array<[Date, string]> = [];

  constructor(readonly id: string, readonly office: string, readonly reportedBy: string, readonly reportedAt: Date) {}

  log(when: Date, text: string): void {
    this.audit.push([when, text]);
  }
}
