/**
 * SQL-backed implementation of domain/reservation.ts's CapStore contract —
 * the real version of what CumulativeCapStore simulates in memory for
 * tests. Implements the exact same semantics (atomic reserve, per-cycle
 * duplicate guard, settle-vs-release), backed by real SQL statements
 * instead of JS Maps.
 *
 * The conditional UPDATE below (`WHERE spent + reserved + amount <= cap`)
 * is the actual atomicity mechanism, not the wrapping db.transaction() —
 * within one Node process, better-sqlite3's synchronous execution already
 * prevents interleaving (same as the in-memory store), but a
 * read-then-conditionally-write pattern would still be wrong in principle
 * and would break under multi-process access to the same file. Checking
 * `changes` from the UPDATE itself (never a preceding SELECT) is what
 * reservation.ts's own docstring specifies, and is what's implemented here.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CapStore, PeriodCap, ReservationResult } from "../domain/reservation.js";

interface CapPeriodRow {
  cap: number;
  spent: number;
  reserved: number;
}

interface ReservationRow {
  obligation_id: string;
  period: string;
  amount: number;
}

export class SqliteCapStore implements CapStore {
  constructor(private readonly db: Database.Database) {}

  initPeriod(obligationId: string, period: string, cap: number): void {
    this.db
      .prepare(
        `INSERT INTO cap_periods (obligation_id, period, cap, spent, reserved)
         VALUES (@obligationId, @period, @cap, 0, 0)
         ON CONFLICT(obligation_id, period) DO NOTHING`,
      )
      .run({ obligationId, period, cap });
  }

  reserve(obligationId: string, period: string, amount: number, cycleId: string): ReservationResult {
    const run = this.db.transaction((): ReservationResult => {
      const duplicate = this.db
        .prepare(`SELECT 1 FROM cap_reservations WHERE cycle_id = ? AND status IN ('RESERVED', 'SETTLED') LIMIT 1`)
        .get(cycleId);
      if (duplicate) {
        return { ok: false, reason: "DUPLICATE_CYCLE" };
      }

      const period_ = this.db
        .prepare(`SELECT cap, spent, reserved FROM cap_periods WHERE obligation_id = ? AND period = ?`)
        .get(obligationId, period) as CapPeriodRow | undefined;
      if (!period_) {
        throw new Error(`Period not initialized: ${obligationId}:${period}`);
      }

      const result = this.db
        .prepare(
          `UPDATE cap_periods
           SET reserved = reserved + @amount
           WHERE obligation_id = @obligationId
             AND period = @period
             AND spent + reserved + @amount <= cap`,
        )
        .run({ obligationId, period, amount });

      if (result.changes === 0) {
        return { ok: false, reason: "CAP_EXCEEDED" };
      }

      const reservationId = `res_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO cap_reservations (id, obligation_id, period, cycle_id, amount, status, created_at)
           VALUES (@id, @obligationId, @period, @cycleId, @amount, 'RESERVED', @createdAt)`,
        )
        .run({ id: reservationId, obligationId, period, cycleId, amount, createdAt: new Date().toISOString() });

      return { ok: true, reservationId };
    });

    return run();
  }

  settle(reservationId: string): void {
    const run = this.db.transaction(() => {
      const row = this.getReservationOrThrow(reservationId);
      this.db
        .prepare(
          `UPDATE cap_periods SET reserved = reserved - @amount, spent = spent + @amount
           WHERE obligation_id = @obligation_id AND period = @period`,
        )
        .run(row);
      this.db.prepare(`UPDATE cap_reservations SET status = 'SETTLED' WHERE id = ?`).run(reservationId);
    });
    run();
  }

  release(reservationId: string): void {
    const run = this.db.transaction(() => {
      const row = this.getReservationOrThrow(reservationId);
      this.db
        .prepare(
          `UPDATE cap_periods SET reserved = reserved - @amount WHERE obligation_id = @obligation_id AND period = @period`,
        )
        .run(row);
      this.db.prepare(`UPDATE cap_reservations SET status = 'RELEASED' WHERE id = ?`).run(reservationId);
    });
    run();
  }

  snapshot(obligationId: string, period: string): PeriodCap {
    const row = this.db
      .prepare(`SELECT cap, spent, reserved FROM cap_periods WHERE obligation_id = ? AND period = ?`)
      .get(obligationId, period) as CapPeriodRow | undefined;
    if (!row) throw new Error(`Period not initialized: ${obligationId}:${period}`);
    return row;
  }

  private getReservationOrThrow(reservationId: string): ReservationRow {
    const row = this.db
      .prepare(`SELECT obligation_id, period, amount FROM cap_reservations WHERE id = ?`)
      .get(reservationId) as ReservationRow | undefined;
    if (!row) throw new Error(`Unknown reservation: ${reservationId}`);
    return row;
  }
}
