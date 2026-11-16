/**
 * Choosing who buys. A pure function: same inputs, same ranking, easy to test and to explain.
 *
 * Eligible = opted in, not on leave, and able to be physically in the office on at least one
 * working day inside the window in which the refill must happen.
 *
 * Ranked by, in order (lower sorts first):
 *   1. unreimbursed claims   - don't ask someone who is still out of pocket
 *   2. recent missed commitments
 *   3. refills done in the last N days (fair share)
 *   4. time since their last refill (longest ago first)
 *   5. employee id (so ties are deterministic, never random)
 */
import { Volunteer } from "./models.js";
import { LocalDate } from "./timeutil.js";

export interface Stats {
  outstandingClaims: number;
  strikes: number;
  recentRefills: number;
  lastRefill: Date | null;
}

export const NO_STATS: Stats = { outstandingClaims: 0, strikes: 0, recentRefills: 0, lastRefill: null };

export function rankCandidates(
  volunteers: Iterable<Volunteer>,
  statsFor: (employeeId: string) => Stats,
  office: string,
  days: LocalDate[],
  exclude: Iterable<string> = [],
): Volunteer[] {
  const excluded = new Set(exclude);
  const pool = [...volunteers].filter(
    (v) => !excluded.has(v.employeeId) && days.some((d) => v.canBeInOffice(office, d)),
  );

  const key = (v: Volunteer): [number, number, number, number, string] => {
    const s = statsFor(v.employeeId);
    return [s.outstandingClaims, s.strikes, s.recentRefills,
            s.lastRefill ? s.lastRefill.getTime() : -Infinity, v.employeeId];
  };

  return pool
    .map((v) => ({ v, k: key(v) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) {
        const x = a.k[i]!, y = b.k[i]!;
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    })
    .map(({ v }) => v);
}
