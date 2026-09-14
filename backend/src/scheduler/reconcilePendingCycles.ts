/**
 * Closes a gap flagged since the quote engine's first pass and never
 * revisited: a cycle that ends up in EXECUTING with a broadcast
 * transaction but no receipt observed within the original send's timeout
 * (engine/quoteEngine.ts's `PENDING_CONFIRMATION` case) previously just sat
 * there forever — nothing ever re-asked the question. For a project whose
 * entire pitch is "the agent proves what it did," a cycle silently stuck in
 * limbo is the one failure mode that directly contradicts that promise —
 * worth closing even though it's rare in practice (Monad testnet
 * confirmations are typically fast well within the original timeout).
 *
 * This is a re-ask, not new judgment: `checkTransactionReceipt()` is the
 * exact same confirmed/reverted interpretation `executeAusdTransfer()`
 * already uses, and `settle()`/`release()` on the existing reservation are
 * exactly what the original path in quoteEngine.ts would have called had
 * the receipt simply arrived a little sooner.
 */

import type Database from "better-sqlite3";
import { transitionCycle } from "../domain/cycleStateMachine.js";
import { listStuckExecutingCycles, saveCycle } from "../persistence/cycles.js";
import { SqliteCapStore } from "../persistence/sqliteCapStore.js";
import type { Hex } from "../domain/types.js";
import type { ReceiptCheckResult } from "../privy/execute.js";

export interface ReconcileDeps {
  db: Database.Database;
  now: () => Date;
  checkReceipt: (hash: Hex) => Promise<ReceiptCheckResult>;
  /**
   * Spacing between reconciliation attempts on the SAME cycle — not the
   * first chance to resolve. By the time a cycle is persisted in EXECUTING
   * with a tx_hash at all, the original send already waited its own
   * confirmationTimeoutMs (60s default) and got nothing; this just avoids
   * re-querying the same hash on every single scheduler tick if it's still
   * within a short window of that.
   */
  graceMs: number;
}

export interface ReconcileOutcome {
  cycleId: string;
  outcome: "SETTLED" | "FAILED" | "STILL_PENDING";
}

export async function reconcilePendingCycles(deps: ReconcileDeps): Promise<ReconcileOutcome[]> {
  const cutoff = new Date(deps.now().getTime() - deps.graceMs).toISOString();
  const stuck = listStuckExecutingCycles(deps.db, cutoff);
  const capStore = new SqliteCapStore(deps.db);
  const results: ReconcileOutcome[] = [];

  for (const cycle of stuck) {
    // listStuckExecutingCycles() already filters on tx_hash IS NOT NULL; a
    // missing reservationId here would mean a cycle reached EXECUTING
    // without ever reserving — shouldn't happen given decisionLoop.ts's own
    // ordering, but skip defensively rather than crash the whole batch.
    if (!cycle.txHash || !cycle.reservationId) continue;

    const { confirmed, reverted } = await deps.checkReceipt(cycle.txHash as Hex);

    if (!confirmed) {
      results.push({ cycleId: cycle.id, outcome: "STILL_PENDING" });
      continue;
    }

    if (reverted) {
      capStore.release(cycle.reservationId);
      const failed = transitionCycle(cycle, "FAILED", {
        reason: `Transaction ${cycle.txHash} was mined but reverted on-chain (found on reconciliation)`,
        at: deps.now().toISOString(),
      });
      saveCycle(deps.db, failed);
      results.push({ cycleId: cycle.id, outcome: "FAILED" });
    } else {
      capStore.settle(cycle.reservationId);
      const settled = transitionCycle(cycle, "SETTLED", { at: deps.now().toISOString() });
      saveCycle(deps.db, settled);
      results.push({ cycleId: cycle.id, outcome: "SETTLED" });
    }
  }

  return results;
}
