/**
 * The actual automation loop: generate any newly-due cycles, then run every
 * due cycle through the real quote engine (real signed quote, real Privy
 * execution, real on-chain confirmation) — not just list them.
 *
 * Depends on an already-constructed `TransferExecutor` and a balance-
 * reading function, not raw Privy/viem objects — same separation
 * engine/quoteEngine.ts already uses, and for the same reason: it makes
 * this fully unit-testable with fakes (see test/runDueCycles.test.ts)
 * instead of needing a real Privy client just to exercise the scheduling
 * logic. server.ts's tryBuildLiveExecutionDeps() constructs the real
 * versions.
 *
 * Two honest scope limitations, not silently glossed over:
 *
 * 1. **No real FX/fee source is integrated.** `MarketDataProvider` is a
 *    clearly-flagged placeholder (`staticMarketDataProvider`, env-var
 *    driven) standing in for a real FX API. The quote it produces is still
 *    fully real and signed, and the executed transfer is still a genuine
 *    on-chain transaction — only the market data feeding the decision is
 *    fake. Do not ship a real remittance product on this; do use it to
 *    prove the scheduling/execution wiring works.
 *
 * 2. **One global demo wallet for every obligation.** There is no
 *    per-user/per-obligation wallet-linkage table yet (real per-user
 *    wallets need real Privy client-side login first, see progress.md's
 *    ownership-model spike). `getAvailableBalanceAusd` and `executor` are
 *    both bound to a single wallet by the caller; every obligation this
 *    processes executes against it. Must be replaced with a real
 *    per-obligation wallet lookup once multi-user wallets exist. The same
 *    limitation applies to `continuity.executor` below.
 *
 * Safety note this DOES rely on genuinely: it is only safe to let a 30s-
 * interval CRE cron call this repeatedly because generateDueCycles() only
 * ever creates a cycle when real calendar time has actually passed for
 * that obligation's cadence — frequent checking is fine, frequent
 * execution is structurally prevented by the schedule itself, not by this
 * function refusing to run.
 *
 * **Dead-man's-switch redirection (Section A.8)**: when `continuity` deps
 * are configured and an obligation has a `backupRecipientId`, sustained
 * inactivity, and an ACTIVE CONTINUITY-kind grant, this cycle's payment
 * goes to the backup recipient via the separate continuity executor
 * instead of the primary recipient/executor — never partially (all three
 * conditions must hold, or the normal path runs unchanged).
 *
 * Deliberately does NOT modify domain/decisionLoop.ts's allowlist gate to
 * special-case this: that gate simply checks the given recipient matches
 * the given envelope's recipientId, and stays that way. Instead, when
 * redirecting, this function builds an "effective envelope" — a shallow
 * copy of the obligation with recipientId swapped to the backup's id — so
 * the existing, already-tested gate logic is satisfied unchanged, and has
 * no idea (or need to know) *why* a different recipient was selected for
 * this particular cycle.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { QuoteInputs } from "../domain/decisionLoop.js";
import { runCycle, type RunCycleOutcome, type TransferExecutor } from "../engine/quoteEngine.js";
import { getObligation } from "../persistence/obligations.js";
import { getRecipient } from "../persistence/recipients.js";
import { listDueCycles, saveCycle } from "../persistence/cycles.js";
import { SqliteCapStore } from "../persistence/sqliteCapStore.js";
import { getActiveGrant } from "../persistence/grants.js";
import { isUserInactive } from "../persistence/users.js";
import { generateDueCycles } from "./generateDueCycles.js";
import type { Hex } from "../domain/types.js";
import { staticMarketDataProvider, type MarketDataProvider } from "../pricing/marketData.js";

export { staticMarketDataProvider, type MarketDataProvider };

export interface RunDueCyclesDeps {
  db: Database.Database;
  now: () => Date;
  market: MarketDataProvider;
  quoteSigningPrivateKey: Hex;
  ausdDecimals: number;
  executor: TransferExecutor;
  /** Re-read before each cycle, not once per batch — see file header. */
  getAvailableBalanceAusd: () => Promise<number>;
  /** Dead-man's-switch (Section A.8). Omit entirely to disable continuity
   *  redirection — never partially applied without both fields present. */
  continuity?: {
    inactivityThresholdDays: number;
    executor: TransferExecutor;
  };
}

export interface DueCycleResult {
  obligationId: string;
  cycleId: string;
  outcome: RunCycleOutcome["outcome"];
  detail: RunCycleOutcome;
}

export async function runDueCycles(deps: RunDueCyclesDeps): Promise<DueCycleResult[]> {
  const now = deps.now();
  generateDueCycles(deps.db, now);
  const due = listDueCycles(deps.db, now.toISOString());

  const capStore = new SqliteCapStore(deps.db);
  const results: DueCycleResult[] = [];

  for (const cycle of due) {
    const obligation = getObligation(deps.db, cycle.obligationId);
    let recipient = obligation ? getRecipient(deps.db, obligation.recipientId) : undefined;
    if (!obligation || !recipient) {
      // Foreign keys should make this impossible, but never let one bad
      // row take down the whole batch.
      continue;
    }

    let effectiveEnvelope = obligation;
    let executor = deps.executor;

    if (deps.continuity && obligation.backupRecipientId) {
      const inactive = isUserInactive(deps.db, obligation.userId, deps.continuity.inactivityThresholdDays, now);
      const continuityGrant = inactive ? getActiveGrant(deps.db, obligation.id, "CONTINUITY") : undefined;
      const backupRecipient = continuityGrant ? getRecipient(deps.db, obligation.backupRecipientId) : undefined;
      if (inactive && continuityGrant && backupRecipient) {
        recipient = backupRecipient;
        effectiveEnvelope = { ...obligation, recipientId: backupRecipient.id };
        executor = deps.continuity.executor;
      }
    }

    const availableBalanceAusd = await deps.getAvailableBalanceAusd();
    const fees = deps.market.getFees();
    const inputs: QuoteInputs = {
      fxRate: deps.market.getFxRate(effectiveEnvelope.localCurrency),
      feeAgentAusd: fees.agentAusd,
      feeNetworkAusd: fees.networkAusd,
      availableBalanceAusd,
      period: now.toISOString().slice(0, 7),
    };

    const outcome = await runCycle(cycle, effectiveEnvelope, recipient, inputs, {
      capStore,
      now: deps.now,
      makeNonce: () => randomUUID(),
      quoteSigningPrivateKey: deps.quoteSigningPrivateKey,
      ausdDecimals: deps.ausdDecimals,
      executor,
    });

    saveCycle(deps.db, outcome.cycle);
    results.push({ obligationId: obligation.id, cycleId: cycle.id, outcome: outcome.outcome, detail: outcome });
  }

  return results;
}
