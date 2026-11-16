/**
 * The refill lifecycle: one place where every state change happens.
 *
 *     OPEN -> OFFERED -> COMMITTED -> PURCHASED -> CLAIMED -> REIMBURSED
 *               |  |         |                        \-> CLAIM_REJECTED
 *               |  |         \-- deadline missed / withdrawn --> OPEN (next candidate)
 *               |  \-- declined / no answer ---------------> OPEN (next candidate)
 *               \-- after N personal offers: broadcast, first volunteer to accept wins
 *     OPEN -> BLOCKED_BUDGET when the month's budget cannot fund even a small refill
 *     any active state -> CANCELLED (false alarm)
 *
 * Concurrency: every command is a synchronous method with no `await` between "check" and "change",
 * so inside one Node process it runs to completion before the next command starts. Check-and-take is
 * therefore atomic here. With several instances, the same guarantee has to come from the database:
 * one transaction per command plus a partial unique index on (office) for ACTIVE states.
 * Time only moves forward through tick(), which a scheduler calls every few minutes.
 */
import { NO_STATS, Stats, rankCandidates } from "./assign.js";
import { BudgetLedger } from "./budget.js";
import { ACTIVE, DEFAULT_POLICY, Office, Policy, Refill, State, Volunteer } from "./models.js";
import { FxRates, Money } from "./money.js";
import { ChatPort, Clock, HRPort, HRUnavailable } from "./ports.js";
import { MonthlyReport, buildReport } from "./reporting.js";
import { addBusinessHours, formatLocal, localDate, localDates, monthOf } from "./timeutil.js";

export class SnackError extends Error {}
export class AlreadyTaken extends SnackError {}
export class NotYourTurn extends SnackError {}
export class NotEligible extends SnackError {}
export class BudgetBlocked extends SnackError {}
export class InvalidState extends SnackError {}
export class ValidationError extends SnackError {}

const DAY_MS = 24 * 3_600_000;

export class SnackService {
  readonly offices: Map<string, Office>;
  readonly volunteers: Map<string, Volunteer>;
  readonly policy: Policy;
  readonly budget: BudgetLedger;
  readonly refills = new Map<string, Refill>();
  /** Committed and missed the deadline. */
  readonly strikes: Array<{ employeeId: string; at: Date }> = [];
  private nextId = 1;

  constructor(offices: Office[], volunteers: Volunteer[], private chat: ChatPort, private hr: HRPort,
              private clock: Clock, policy: Partial<Policy> = {}) {
    this.offices = new Map(offices.map((o) => [o.name, o]));
    this.volunteers = new Map(volunteers.map((v) => [v.employeeId, v]));
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.budget = new BudgetLedger(this.offices);
  }

  // ------------------------------------------------------------------ commands

  /** Anyone may report. A second report while a refill is in progress returns the same refill. */
  reportEmpty(office: string, reportedBy: string): Refill {
    const now = this.clock.now();
    this.office(office);
    const active = this.activeRefill(office);
    if (active) {
      active.log(now, `duplicate empty-report from ${reportedBy} ignored`);
      return active;
    }
    const r = new Refill(`R${this.nextId++}`, office, reportedBy, now);
    this.refills.set(r.id, r);
    r.log(now, `reported empty by ${reportedBy}`);
    this.advance(r);
    return r;
  }

  /** Volunteer commits. Reserves budget and starts the deadline. First valid caller wins. */
  accept(refillId: string, employeeId: string): Refill {
    const now = this.clock.now();
    const r = this.get(refillId);
    const v = this.volunteer(employeeId);
    const office = this.office(r.office);

    if (r.state === State.COMMITTED) {
      if (r.assignee === employeeId) return r;                 // double tap: harmless
      throw new AlreadyTaken(`${r.id} is already taken`);
    }
    if (r.state === State.OFFERED) {
      if (r.assignee !== employeeId) throw new NotYourTurn(`${r.id} is currently offered to someone else`);
      // Allowed even if the offer is past its time and tick() has not run yet:
      // they are still the only person who was asked.
    } else if (r.state === State.OPEN && r.broadcast) {
      const today = localDate(now, office.tz);
      if (!(v.active && !v.isAway(today) && v.effectiveOffice(today) === office.name)) {
        throw new NotEligible(`${v.name} cannot refill the ${office.name} box today`);
      }
    } else {
      throw new InvalidState(`${r.id} is ${r.state}`);
    }

    const month = monthOf(now, office.tz);
    const cap = Money.min(office.maxPurchase, this.budget.remaining(office.name, month));
    if (cap.lt(office.minPurchase)) {
      this.advance(r);                                         // moves to BLOCKED_BUDGET and alerts the manager
      throw new BudgetBlocked(`not enough ${office.name} budget left this month`);
    }

    this.budget.reserve(r.id, office.name, month, cap);
    r.assignee = employeeId;
    r.state = State.COMMITTED;
    r.cap = cap;
    r.offerExpiresAt = null;
    r.dueAt = addBusinessHours(now, this.policy.commitTtlHours, office.tz);
    r.log(now, `${employeeId} committed, cap ${cap}, due ${r.dueAt.toISOString()}`);
    this.chat.dm(employeeId, `Thanks! Please refill the ${office.name} box, spend up to ${cap}, ` +
      `and send the receipt here by ${formatLocal(r.dueAt, office.tz)}.`);
    if (r.broadcast) this.chat.post(office.name, `${v.name} is refilling the box. No need to buy.`);
    return r;
  }

  decline(refillId: string, employeeId: string): Refill {
    const r = this.get(refillId);
    if (r.state !== State.OFFERED || r.assignee !== employeeId) {
      throw new NotYourTurn(`${r.id} is not offered to ${employeeId}`);
    }
    r.tried.push(employeeId);
    r.log(this.clock.now(), `${employeeId} declined`);
    this.advance(r);
    return r;
  }

  /** A committed volunteer says early that they cannot do it. No strike: telling us is the right thing. */
  withdraw(refillId: string, employeeId: string): Refill {
    const r = this.get(refillId);
    if (r.state !== State.COMMITTED || r.assignee !== employeeId) {
      throw new NotYourTurn(`${employeeId} has not committed to ${r.id}`);
    }
    this.releaseCommitment(r, false, "withdrew");
    return r;
  }

  /**
   * Records the purchase and files the HR claim straight away.
   *
   * Accepted from the current holder, and also from someone who lost the commitment by missing the
   * deadline but bought anyway: the box is refilled, so reality wins and they still get reimbursed.
   */
  submitReceipt(refillId: string, employeeId: string, amount: Money, receiptRef: string,
                items: Record<string, number> = {}): Refill {
    const now = this.clock.now();
    const r = this.get(refillId);
    const office = this.office(r.office);
    if (!ACTIVE.has(r.state)) throw new InvalidState(`${r.id} is ${r.state}; the box is already refilled`);
    if (employeeId !== r.assignee && !r.formerAssignees.has(employeeId)) {
      throw new NotYourTurn(`${employeeId} is not the buyer for ${r.id}`);
    }
    if (amount.currency !== office.currency) {
      throw new ValidationError(`${office.name} receipts must be in ${office.currency}`);
    }
    if (amount.minor <= 0 || !receiptRef) throw new ValidationError("need a positive amount and a receipt image");

    if (r.assignee && r.assignee !== employeeId) {
      this.chat.dm(r.assignee, `${r.id} has already been refilled. No need to buy.`);
    }
    const limit = r.cap ?? office.maxPurchase;
    this.budget.release(r.id);
    this.budget.spend(r.id, office.name, monthOf(now, office.tz), amount);
    r.assignee = employeeId;
    r.amount = amount;
    r.receiptRef = receiptRef;
    r.items = { ...items };
    r.purchasedAt = now;
    r.state = State.PURCHASED;
    r.offerExpiresAt = null;
    r.dueAt = null;
    r.log(now, `${employeeId} bought for ${amount}`);
    if (amount.gt(limit)) {
      r.overCap = true;
      this.chat.dm(office.managerId, `${r.id}: ${amount} spent, over the ${limit} cap. ` +
        `The claim was filed; this month's budget has been charged.`);
    }
    this.fileClaim(r);
    return r;
  }

  cancel(refillId: string): Refill {
    const r = this.get(refillId);
    if (!ACTIVE.has(r.state)) throw new InvalidState(`${r.id} is ${r.state}`);
    this.budget.release(r.id);
    if (r.assignee) this.chat.dm(r.assignee, `${r.id} was cancelled. No need to buy.`);
    r.state = State.CANCELLED;
    r.assignee = null;
    r.log(this.clock.now(), "cancelled");
    return r;
  }

  /** Manager tops up a month. Refills that were blocked on budget are retried immediately. */
  addBudget(office: string, month: string, amount: Money, approver: string): void {
    this.budget.addFunds(office, month, amount, approver);
    for (const r of this.refills.values()) {
      if (r.office === office && r.state === State.BLOCKED_BUDGET) this.advance(r);
    }
  }

  // ------------------------------------------------------------------ time-driven

  /** Run every few minutes: expire offers, reassign missed commitments, retry and track claims. */
  tick(): void {
    const now = this.clock.now().getTime();
    for (const r of [...this.refills.values()]) {
      if (r.state === State.OFFERED && now >= r.offerExpiresAt!.getTime()) this.offerExpired(r);
      else if (r.state === State.COMMITTED && now >= r.dueAt!.getTime()) {
        this.releaseCommitment(r, true, "missed the deadline");
      } else if (r.state === State.BLOCKED_BUDGET) this.advance(r);   // a new month, or a top-up, may have freed budget
      else if (r.state === State.PURCHASED) this.fileClaim(r);        // HR was down last time
      else if (r.state === State.CLAIMED) this.syncClaim(r);
    }
  }

  monthlyReport(month: string, fx: FxRates): MonthlyReport {
    return buildReport(month, this.offices, this.budget, [...this.refills.values()], fx);
  }

  // ------------------------------------------------------------------ internals

  /** Find the next step for a refill that needs a buyer: blocked, personal offer, or broadcast. */
  private advance(r: Refill): void {
    const now = this.clock.now();
    const office = this.office(r.office);
    r.assignee = null;
    r.offerExpiresAt = null;
    const remaining = this.budget.remaining(office.name, monthOf(now, office.tz));
    if (remaining.lt(office.minPurchase)) {
      if (r.state !== State.BLOCKED_BUDGET) {
        r.state = State.BLOCKED_BUDGET;
        r.log(now, `blocked: only ${remaining} left this month`);
        this.chat.dm(office.managerId, `The ${office.name} snack box is empty but only ${remaining} ` +
          `of this month's budget is left. Top up to continue.`);
      }
      return;
    }
    r.state = State.OPEN;

    if (r.tried.length < this.policy.maxTargetedAttempts) {
      const due = addBusinessHours(now, this.policy.commitTtlHours, office.tz);
      const days = localDates(now, due, office.tz);
      const ranked = rankCandidates(this.volunteers.values(), (e) => this.stats(e, now), office.name, days, r.tried);
      const v = ranked[0];
      if (v) {
        r.state = State.OFFERED;
        r.assignee = v.employeeId;
        r.broadcast = false;
        r.offerExpiresAt = addBusinessHours(now, this.policy.offerTtlHours, office.tz);
        r.log(now, `offered to ${v.employeeId}`);
        this.chat.dm(v.employeeId, `The ${office.name} snack box is empty. Can you refill it? ` +
          `Budget up to ${Money.min(office.maxPurchase, remaining)}. ` +
          `Please answer by ${formatLocal(r.offerExpiresAt, office.tz)}.`);
        return;
      }
    }

    r.broadcast = true;
    r.log(now, "broadcast to the whole office");
    this.chat.post(office.name, `The snack box is empty and needs a volunteer. ` +
      `First to tap 'I'll buy' gets it (${r.id}).`);
  }

  private offerExpired(r: Refill): void {
    const who = r.assignee!;
    r.tried.push(who);
    r.log(this.clock.now(), `offer to ${who} expired`);
    this.chat.dm(who, `The ${r.office} refill offer has expired and was passed on.`);
    this.advance(r);
  }

  private releaseCommitment(r: Refill, strike: boolean, reason: string): void {
    const now = this.clock.now();
    const who = r.assignee!;
    this.budget.release(r.id);
    r.tried.push(who);
    r.cap = null;
    r.dueAt = null;
    if (strike) {
      this.strikes.push({ employeeId: who, at: now });
      r.formerAssignees.add(who);
      this.chat.dm(who, `The deadline for ${r.id} passed, so it was passed to someone else. If you ` +
        `already bought snacks, send the receipt anyway and you will still be reimbursed.`);
    } else {
      this.chat.dm(who, `Thanks for letting us know. ${r.id} was passed to someone else.`);
    }
    r.log(now, `${who} ${reason}`);
    this.advance(r);
  }

  private fileClaim(r: Refill): void {
    const now = this.clock.now();
    const office = this.office(r.office);
    let claimId: string;
    try {
      claimId = this.hr.submitClaim({
        idempotencyKey: r.id,
        employeeId: r.assignee!,
        amount: r.amount!,
        description: `Office snacks, ${r.office}, refill ${r.id}, ${localDate(r.purchasedAt!, office.tz)}`,
        receiptRef: r.receiptRef!,
      });
    } catch (e) {
      if (!(e instanceof HRUnavailable)) throw e;
      r.log(now, "HR unavailable, claim will be retried");
      return;
    }
    r.claimId = claimId;
    r.claimSubmittedAt = now;
    r.state = State.CLAIMED;
    r.log(now, `claim ${claimId} filed`);
    this.chat.dm(r.assignee!, `Your claim for ${r.amount} is filed (${claimId}). HR usually approves within 1-10 days.`);
  }

  private syncClaim(r: Refill): void {
    const now = this.clock.now();
    const office = this.office(r.office);
    let status;
    try {
      status = this.hr.claimStatus(r.claimId!);
    } catch (e) {
      if (e instanceof HRUnavailable) return;
      throw e;
    }
    if (status === "APPROVED") {
      r.state = State.REIMBURSED;
      r.reimbursedAt = now;
      r.log(now, "reimbursed");
      this.chat.dm(r.assignee!, `Your claim ${r.claimId} for ${r.amount} was approved. Thank you!`);
    } else if (status === "REJECTED") {
      r.state = State.CLAIM_REJECTED;
      r.log(now, "claim rejected by HR");
      this.chat.dm(office.managerId, `HR rejected claim ${r.claimId} (${r.amount}) for ${r.assignee}. Please follow up.`);
      this.chat.dm(r.assignee!, `HR rejected claim ${r.claimId}. ${office.name}'s manager has been told.`);
    } else if (!r.chased && now.getTime() - r.claimSubmittedAt!.getTime() > this.policy.claimChaseDays * DAY_MS) {
      r.chased = true;
      r.log(now, "claim pending longer than expected");
      this.chat.dm(office.managerId, `Claim ${r.claimId} (${r.amount}) has been pending with HR for ` +
        `over ${this.policy.claimChaseDays} days.`);
    }
  }

  private stats(employeeId: string, now: Date): Stats {
    const windowStart = now.getTime() - this.policy.historyDays * DAY_MS;
    const mine = [...this.refills.values()].filter((r) => r.assignee === employeeId);
    const done = mine.filter((r) => r.purchasedAt).map((r) => r.purchasedAt!.getTime());
    return {
      ...NO_STATS,
      outstandingClaims: mine.filter((r) => r.state === State.PURCHASED || r.state === State.CLAIMED).length,
      strikes: this.strikes.filter((s) => s.employeeId === employeeId && s.at.getTime() >= windowStart).length,
      recentRefills: done.filter((t) => t >= windowStart).length,
      lastRefill: done.length ? new Date(Math.max(...done)) : null,
    };
  }

  private activeRefill(office: string): Refill | undefined {
    return [...this.refills.values()].find((r) => r.office === office && ACTIVE.has(r.state));
  }

  private office(name: string): Office {
    const o = this.offices.get(name);
    if (!o) throw new SnackError(`unknown office ${name}`);
    return o;
  }

  private get(refillId: string): Refill {
    const r = this.refills.get(refillId);
    if (!r) throw new SnackError(`unknown refill ${refillId}`);
    return r;
  }

  private volunteer(employeeId: string): Volunteer {
    const v = this.volunteers.get(employeeId);
    if (!v) throw new NotEligible(`${employeeId} is not a registered volunteer`);
    return v;
  }
}
