import type Database from "better-sqlite3";
import type { Cycle, CycleState } from "../domain/types.js";

interface CycleRow {
  id: string;
  obligation_id: string;
  due_at: string;
  state: string;
  quote_json: string | null;
  reservation_id: string | null;
  reason: string | null;
  history_json: string;
  created_at: string;
  updated_at: string;
}

function rowToCycle(row: CycleRow): Cycle {
  return {
    id: row.id,
    obligationId: row.obligation_id,
    dueAt: row.due_at,
    state: row.state as CycleState,
    quote: row.quote_json ? JSON.parse(row.quote_json) : undefined,
    reservationId: row.reservation_id ?? undefined,
    reason: row.reason ?? undefined,
    history: JSON.parse(row.history_json),
  };
}

export function insertCycle(db: Database.Database, cycle: Cycle): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cycles
       (id, obligation_id, due_at, state, quote_json, reservation_id, reason, history_json, created_at, updated_at)
     VALUES
       (@id, @obligationId, @dueAt, @state, @quoteJson, @reservationId, @reason, @historyJson, @createdAt, @updatedAt)`,
  ).run({
    id: cycle.id,
    obligationId: cycle.obligationId,
    dueAt: cycle.dueAt,
    state: cycle.state,
    quoteJson: cycle.quote ? JSON.stringify(cycle.quote) : null,
    reservationId: cycle.reservationId ?? null,
    reason: cycle.reason ?? null,
    historyJson: JSON.stringify(cycle.history),
    createdAt: now,
    updatedAt: now,
  });
}

/** Persists a cycle's current state after a transition — never re-inserts. */
export function saveCycle(db: Database.Database, cycle: Cycle): void {
  db.prepare(
    `UPDATE cycles
     SET due_at = @dueAt, state = @state, quote_json = @quoteJson, reservation_id = @reservationId,
         reason = @reason, history_json = @historyJson, updated_at = @updatedAt
     WHERE id = @id`,
  ).run({
    id: cycle.id,
    dueAt: cycle.dueAt,
    state: cycle.state,
    quoteJson: cycle.quote ? JSON.stringify(cycle.quote) : null,
    reservationId: cycle.reservationId ?? null,
    reason: cycle.reason ?? null,
    historyJson: JSON.stringify(cycle.history),
    updatedAt: new Date().toISOString(),
  });
}

export function getCycle(db: Database.Database, id: string): Cycle | undefined {
  const row = db.prepare(`SELECT * FROM cycles WHERE id = ?`).get(id) as CycleRow | undefined;
  return row ? rowToCycle(row) : undefined;
}

export function listCyclesForObligation(db: Database.Database, obligationId: string): Cycle[] {
  const rows = db
    .prepare(`SELECT * FROM cycles WHERE obligation_id = ? ORDER BY due_at`)
    .all(obligationId) as CycleRow[];
  return rows.map(rowToCycle);
}

/**
 * Cycles a real scheduler should act on right now: still PENDING_QUOTE,
 * due at or before `asOf`, and belonging to an obligation that's still
 * ACTIVE (Section A.10 step 1 — a trigger firing is an input to check, not
 * proof a payment is due; this query is exactly that check).
 */
export function listDueCycles(db: Database.Database, asOf: string): Cycle[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM cycles c
       JOIN obligations o ON o.id = c.obligation_id
       WHERE c.state = 'PENDING_QUOTE' AND c.due_at <= ? AND o.status = 'ACTIVE'
       ORDER BY c.due_at`,
    )
    .all(asOf) as CycleRow[];
  return rows.map(rowToCycle);
}
