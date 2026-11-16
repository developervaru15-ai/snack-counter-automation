/** Simulated stand-ins for the chat tool, the HR system and the clock. */
import { Money } from "./money.js";
import { ChatPort, ClaimRequest, ClaimStatus, Clock, HRPort, HRUnavailable } from "./ports.js";

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(d: { days?: number; hours?: number; minutes?: number }): void {
    const ms = ((d.days ?? 0) * 24 + (d.hours ?? 0)) * 3_600_000 + (d.minutes ?? 0) * 60_000;
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeChat implements ChatPort {
  dms: Array<[string, string]> = [];
  posts: Array<[string, string]> = [];

  dm(employeeId: string, text: string): void {
    this.dms.push([employeeId, text]);
  }

  post(office: string, text: string): void {
    this.posts.push([office, text]);
  }

  dmsTo(employeeId: string): string[] {
    return this.dms.filter(([e]) => e === employeeId).map(([, t]) => t);
  }
}

export interface FakeClaim {
  employeeId: string;
  amount: Money;
  description: string;
  receiptRef: string;
  submittedAt: Date;
  rejected: boolean;
}

/** Approves a claim `approvalDays` after submission unless it was rejected. Can be switched off. */
export class FakeHR implements HRPort {
  down = false;
  claims = new Map<string, FakeClaim>();
  private byKey = new Map<string, string>();

  constructor(private clock: Clock, private approvalDays = 3) {}

  submitClaim(req: ClaimRequest): string {
    if (this.down) throw new HRUnavailable("HR is down");
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing;
    const id = `HR-${this.claims.size + 1}`;
    this.claims.set(id, {
      employeeId: req.employeeId, amount: req.amount, description: req.description,
      receiptRef: req.receiptRef, submittedAt: this.clock.now(), rejected: false,
    });
    this.byKey.set(req.idempotencyKey, id);
    return id;
  }

  claimStatus(claimId: string): ClaimStatus {
    if (this.down) throw new HRUnavailable("HR is down");
    const c = this.claims.get(claimId)!;
    if (c.rejected) return "REJECTED";
    const approvedAt = c.submittedAt.getTime() + this.approvalDays * 24 * 3_600_000;
    return this.clock.now().getTime() >= approvedAt ? "APPROVED" : "PENDING";
  }

  reject(claimId: string): void {
    this.claims.get(claimId)!.rejected = true;
  }
}
