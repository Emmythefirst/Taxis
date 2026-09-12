/**
 * The quote engine — wires the pure decision loop (domain/decisionLoop.ts)
 * to real quote signing and real on-chain execution. This is the function
 * that actually runs each cycle in production; decisionLoop.ts alone never
 * touches money, this module is where a AUTO_APPROVED decision becomes a
 * real AUSD transfer.
 *
 * `executor` is injected (not a bare PrivyClient) so tests can run the full
 * EXECUTING -> SETTLED/FAILED path without any network access — see
 * test/quoteEngine.test.ts. The real executor is a thin wrapper around
 * privy/execute.ts's executeAusdTransfer().
 */

import { transitionCycle } from "../domain/cycleStateMachine.js";
import { runDecisionLoop, type DecisionDeps, type QuoteInputs } from "../domain/decisionLoop.js";
import type { CumulativeCapStore } from "../domain/reservation.js";
import type { Cycle, Hex, ObligationEnvelope, Quote, Recipient } from "../domain/types.js";
import { parseDecimalToBaseUnits } from "../domain/units.js";
import { signQuote } from "../quoting/signing.js";
import type { ExecuteTransferResult } from "../privy/execute.js";

export interface TransferExecutor {
  execute(params: {
    recipientAddress: Hex;
    amountBaseUnits: bigint;
  }): Promise<ExecuteTransferResult>;
}

export interface QuoteEngineDeps {
  capStore: CumulativeCapStore;
  now: () => Date;
  makeNonce: () => string;
  quoteSigningPrivateKey: Hex;
  /** AUSD's on-chain decimals — needed to convert the quote's human-decimal
   *  ausdAmount into base units right before execution (see units.ts). */
  ausdDecimals: number;
  executor: TransferExecutor;
}

export type RunCycleOutcome =
  | { outcome: "SETTLED"; cycle: Cycle; quote: Quote; txHash: string }
  | { outcome: "REQUIRES_APPROVAL"; cycle: Cycle; quote: Quote }
  | { outcome: "SKIPPED"; cycle: Cycle; reason: string }
  | { outcome: "FAILED"; cycle: Cycle; reason: string }
  /**
   * A transaction was broadcast but no receipt was observed in time — its
   * fate is genuinely unknown, not negative. The cycle stays in EXECUTING
   * (a real, non-terminal state it can still legally move on from) and its
   * reservation is deliberately left untouched: releasing it here would let
   * a later retry double-pay if the original transaction still lands.
   * Resolving this requires a reconciliation step that checks `txHash` and
   * calls settle()/release() once the true outcome is known — not built
   * yet, and callers must not guess in its place.
   */
  | { outcome: "PENDING_CONFIRMATION"; cycle: Cycle; quote: Quote; txHash: string };

export async function runCycle(
  cycle: Cycle,
  envelope: ObligationEnvelope,
  recipient: Recipient,
  inputs: QuoteInputs,
  deps: QuoteEngineDeps,
): Promise<RunCycleOutcome> {
  const decisionDeps: DecisionDeps = {
    capStore: deps.capStore,
    now: deps.now,
    makeNonce: deps.makeNonce,
    sign: (unsigned) => signQuote(unsigned, deps.quoteSigningPrivateKey),
  };

  const decision = runDecisionLoop(cycle, envelope, recipient, inputs, decisionDeps);

  if (decision.outcome === "SKIPPED") {
    return { outcome: "SKIPPED", cycle: decision.cycle, reason: decision.reason };
  }
  if (decision.outcome === "REQUIRES_APPROVAL") {
    return { outcome: "REQUIRES_APPROVAL", cycle: decision.cycle, quote: decision.quote };
  }

  // AUTO_APPROVED: actually move the money.
  const now = deps.now().toISOString();
  const executing = transitionCycle(decision.cycle, "EXECUTING", { at: now });

  try {
    const amountBaseUnits = parseDecimalToBaseUnits(decision.quote.ausdAmount, deps.ausdDecimals);
    const result = await deps.executor.execute({
      recipientAddress: decision.quote.recipientAddress,
      amountBaseUnits,
    });

    if (!result.confirmed) {
      // See RunCycleOutcome's PENDING_CONFIRMATION doc — deliberately no
      // state transition and no reservation release here.
      return { outcome: "PENDING_CONFIRMATION", cycle: executing, quote: decision.quote, txHash: result.hash };
    }

    if (result.reverted) {
      // Confirmed on-chain revert — an ERC-20 revert rolls back the
      // transfer entirely, so funds definitely did not move. Safe to
      // release and let this cycle be retried.
      deps.capStore.release(executing.reservationId!);
      const reason = `Transaction ${result.hash} was mined but reverted on-chain`;
      const failed = transitionCycle(executing, "FAILED", { reason, at: deps.now().toISOString() });
      return { outcome: "FAILED", cycle: failed, reason };
    }

    deps.capStore.settle(executing.reservationId!);
    const settled = transitionCycle(executing, "SETTLED", { at: deps.now().toISOString() });
    return { outcome: "SETTLED", cycle: settled, quote: decision.quote, txHash: result.hash };
  } catch (err) {
    // A rejected send (policy_violation, expired grant, etc.) — nothing was
    // ever broadcast. This IS the enforcement working as designed, not a
    // bug — surface it as a real cycle failure and release the reservation
    // so it isn't stuck forever (this cycle can legitimately retry later;
    // see reservation.ts).
    deps.capStore.release(executing.reservationId!);
    const reason = err instanceof Error ? err.message : String(err);
    const failed = transitionCycle(executing, "FAILED", { reason, at: deps.now().toISOString() });
    return { outcome: "FAILED", cycle: failed, reason };
  }
}
