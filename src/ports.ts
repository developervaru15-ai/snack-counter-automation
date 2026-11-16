/** The two outside systems, as narrow interfaces. Real adapters would implement these. */
import { Money } from "./money.js";

/** HR could not be reached. The claim stays in PURCHASED and is retried on the next tick. */
export class HRUnavailable extends Error {}

export interface Clock {
  now(): Date;
}

export interface ChatPort {
  dm(employeeId: string, text: string): void;
  post(office: string, text: string): void;
}

export interface ClaimRequest {
  idempotencyKey: string;   // the same key must never create a second claim
  employeeId: string;
  amount: Money;
  description: string;
  receiptRef: string;
}

export type ClaimStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface HRPort {
  /** Create a claim and return HR's claim id. Throws HRUnavailable if HR cannot be reached. */
  submitClaim(req: ClaimRequest): string;
  claimStatus(claimId: string): ClaimStatus;
}
