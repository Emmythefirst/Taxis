/**
 * Turns "an obligation's cadence" into real PENDING_QUOTE cycle rows.
 * `persistence/cycles.ts`'s listDueCycles() can only find cycles that
 * already exist — this is what creates them in the first place.
 *
 * Deliberately looks at the LAST cycle regardless of its outcome (SETTLED,
 * SKIPPED, FAILED, ...) as the anchor for the next due date: cycle
 * generation is calendar scheduling, not a retry mechanism. A failed
 * cycle's own retry (same cycle_id) is reservation.ts's release-then-retry
 * path, not a reason to generate a second cycle for the same period.
 *
 * Catches up fully in one call rather than one missed period per
 * invocation — if the scheduler hasn't run in a while, calling this once
 * backfills every due cycle up to `now`, not just the next one.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { computeNextDueAt } from "../domain/cadence.js";
import { createCycle } from "../domain/cycleStateMachine.js";
import { listActiveObligations } from "../persistence/obligations.js";
import { insertCycle, listCyclesForObligation } from "../persistence/cycles.js";

export interface GeneratedCycle {
  obligationId: string;
  cycleId: string;
  dueAt: string;
}

export function generateDueCycles(db: Database.Database, now: Date = new Date()): GeneratedCycle[] {
  const generated: GeneratedCycle[] = [];

  for (const obligation of listActiveObligations(db)) {
    const existing = listCyclesForObligation(db, obligation.id);
    let lastDueAt = existing.length > 0 ? new Date(existing[existing.length - 1]!.dueAt) : null;
    const createdAt = new Date(obligation.createdAt);

    for (;;) {
      const nextDue = computeNextDueAt(obligation.cadence, lastDueAt, createdAt);
      if (lastDueAt !== null && nextDue.getTime() <= lastDueAt.getTime()) {
        // Would only happen if computeNextDueAt had a bug — fail loudly
        // rather than spin forever creating cycles for the same instant.
        throw new Error(
          `computeNextDueAt did not advance for obligation ${obligation.id}: ${lastDueAt.toISOString()} -> ${nextDue.toISOString()}`,
        );
      }
      if (nextDue.getTime() > now.getTime()) break;

      const cycleId = `cyc_${randomUUID()}`;
      const cycle = createCycle(obligation.id, cycleId, nextDue.toISOString());
      insertCycle(db, cycle);
      generated.push({ obligationId: obligation.id, cycleId, dueAt: cycle.dueAt });
      lastDueAt = nextDue;
    }
  }

  return generated;
}
