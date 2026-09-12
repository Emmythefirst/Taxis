/**
 * Atomic cumulative-cap reservation — progress.md Section A.6.
 *
 * Privy's policy engine has no native "$X per rolling period" condition; it
 * only evaluates one transaction at a time. Taxis must track cumulative
 * spend per obligation per period itself, and the check-then-reserve must be
 * a single atomic operation, never a separate read followed by a separate
 * write — otherwise two concurrent cycles can both read a stale `spent`
 * value and both approve, blowing past the cap they're each individually
 * respecting.
 *
 * In production this is one conditional SQL UPDATE:
 *
 *   UPDATE obligation_periods
 *   SET reserved = reserved + :amount
 *   WHERE obligation_id = :obligationId
 *     AND period = :period
 *     AND spent + reserved + :amount <= cap
 *
 * ...and the caller checks rows-affected, not a prior SELECT. The store
 * below is an in-memory stand-in with the same contract (single synchronous
 * critical section per key) so the domain logic and its tests don't need a
 * real database yet.
 *
 * **Per-cycle uniqueness (Section A.12, duplicate execution)**: once a
 * recurring obligation moved from "attach a fresh Privy policy every cycle"
 * to a durable policy re-consented periodically (see progress.md Build Log,
 * 2026-09-12 entry on the owner/agent-quorum spike), Privy's enclave lost
 * any notion of "this specific cycle already ran" — it will happily co-sign
 * two identically-shaped transactions inside the same still-valid policy
 * window. There is no on-chain backstop against replaying a cycle_id
 * anymore, so this store is now the *only* thing enforcing it: a cycle_id
 * that's already reserved or already settled can never be reserved again,
 * regardless of whether the cumulative cap would otherwise allow it. A
 * *released* reservation (a genuine execution failure, not a duplicate
 * trigger) clears the cycle_id so a legitimate retry stays possible —
 * settling it does not, since a settled cycle must never pay twice.
 */

export interface PeriodCap {
  cap: number;
  spent: number;
  reserved: number;
}

export type ReservationResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "CAP_EXCEEDED" }
  | { ok: false; reason: "DUPLICATE_CYCLE" };

export class CumulativeCapStore {
  private periods = new Map<string, PeriodCap>();
  private nextReservationId = 1;
  private reservations = new Map<string, { key: string; amount: number; cycleId: string }>();
  /** cycle_ids currently reserved (not yet settled or released). */
  private activeCycles = new Set<string>();
  /** cycle_ids that have settled — permanently blocked from reservation. */
  private settledCycles = new Set<string>();

  private key(obligationId: string, period: string): string {
    return `${obligationId}:${period}`;
  }

  initPeriod(obligationId: string, period: string, cap: number): void {
    const key = this.key(obligationId, period);
    if (!this.periods.has(key)) {
      this.periods.set(key, { cap, spent: 0, reserved: 0 });
    }
  }

  /**
   * Atomic reserve: the duplicate-cycle check, the cap check, and the write
   * all happen in one synchronous step, so no other call can interleave
   * between them (this is what a single conditional UPDATE guarantees in a
   * real DB under row-level locking — this in-memory version relies on JS's
   * run-to-completion semantics for synchronous functions instead).
   */
  reserve(obligationId: string, period: string, amount: number, cycleId: string): ReservationResult {
    if (this.activeCycles.has(cycleId) || this.settledCycles.has(cycleId)) {
      return { ok: false, reason: "DUPLICATE_CYCLE" };
    }

    const key = this.key(obligationId, period);
    const p = this.periods.get(key);
    if (!p) throw new Error(`Period not initialized: ${key}`);

    if (p.spent + p.reserved + amount > p.cap) {
      return { ok: false, reason: "CAP_EXCEEDED" };
    }
    p.reserved += amount;
    const reservationId = `res_${this.nextReservationId++}`;
    this.reservations.set(reservationId, { key, amount, cycleId });
    this.activeCycles.add(cycleId);
    return { ok: true, reservationId };
  }

  settle(reservationId: string): void {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`Unknown reservation: ${reservationId}`);
    const p = this.periods.get(r.key)!;
    p.reserved -= r.amount;
    p.spent += r.amount;
    this.reservations.delete(reservationId);
    this.activeCycles.delete(r.cycleId);
    this.settledCycles.add(r.cycleId);
  }

  release(reservationId: string): void {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`Unknown reservation: ${reservationId}`);
    const p = this.periods.get(r.key)!;
    p.reserved -= r.amount;
    this.reservations.delete(reservationId);
    this.activeCycles.delete(r.cycleId);
  }

  snapshot(obligationId: string, period: string): PeriodCap {
    const p = this.periods.get(this.key(obligationId, period));
    if (!p) throw new Error(`Period not initialized: ${this.key(obligationId, period)}`);
    return { ...p };
  }
}

/**
 * A deliberately-racy reference implementation kept ONLY to demonstrate, in
 * tests, the exact bug class the atomic store above prevents: a plain
 * `if (spent + amount <= limit)` check with an `await` between the read and
 * the write. Never use this pattern against a real database.
 */
export class NaiveReadThenWriteStore {
  private spent = new Map<string, number>();
  /** Every amount that passed its (stale) check — the real hazard: both
   *  payments actually go out, regardless of what the ledger ends up
   *  recording afterwards. */
  approvedAmounts: number[] = [];

  init(key: string): void {
    if (!this.spent.has(key)) this.spent.set(key, 0);
  }

  async reserve(key: string, amount: number, cap: number): Promise<boolean> {
    const current = this.spent.get(key)!;
    // Simulates a network round-trip (e.g. a separate SELECT) between the
    // read and the write, which is exactly where the race window opens.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (current + amount > cap) return false;
    this.spent.set(key, current + amount);
    this.approvedAmounts.push(amount);
    return true;
  }

  get(key: string): number {
    return this.spent.get(key)!;
  }
}
