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
import type { CapStore } from "../domain/reservation.js";
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
  capStore: CapStore;
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

  return executeApprovedCycle(decision.cycle, decision.quote, deps);
}

/**
 * The shared "actually move the money" tail — used both by runCycle()'s
 * AUTO_APPROVED path and by approveCycle() below (a user tapping "Approve
 * anyway" on an already-quoted REQUIRES_APPROVAL cycle, Section A.3/A.11's
 * "Payment paused... needs your approval" screen). Never regenerates the
 * quote — that would defeat the point of showing the user the exact numbers
 * they're approving.
 */
async function executeApprovedCycle(
  cycle: Cycle,
  quote: Quote,
  deps: Pick<QuoteEngineDeps, "capStore" | "now" | "ausdDecimals" | "executor">,
): Promise<RunCycleOutcome> {
  const now = deps.now().toISOString();
  const executing = transitionCycle(cycle, "EXECUTING", { at: now });

  try {
    const amountBaseUnits = parseDecimalToBaseUnits(quote.ausdAmount, deps.ausdDecimals);
    const result = await deps.executor.execute({
      recipientAddress: quote.recipientAddress,
      amountBaseUnits,
    });

    if (!result.confirmed) {
      // See RunCycleOutcome's PENDING_CONFIRMATION doc — deliberately no
      // state transition and no reservation release here.
      return { outcome: "PENDING_CONFIRMATION", cycle: executing, quote, txHash: result.hash };
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
    return { outcome: "SETTLED", cycle: settled, quote, txHash: result.hash };
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

export type ApproveCycleOutcome = RunCycleOutcome | { outcome: "EXPIRED"; cycle: Cycle; reason: string };

/**
 * The user's real "Approve anyway" tap (Section A.3/A.11) on a cycle
 * already sitting in REQUIRES_APPROVAL with a live, previously-generated
 * quote (decisionLoop.ts already reserved its cumulative-cap allocation —
 * see reservation.ts — so this never re-reserves). Executes that EXACT
 * quote, not a freshly regenerated one: the whole point of showing the user
 * concrete numbers before asking for approval is that those are the numbers
 * that execute, not a new estimate. Gate 3 (Section A.9) is re-checked here
 * since real time may have passed since the quote was issued.
 */
export async function approveCycle(
  cycle: Cycle,
  deps: Pick<QuoteEngineDeps, "capStore" | "now" | "ausdDecimals" | "executor">,
): Promise<ApproveCycleOutcome> {
  if (cycle.state !== "REQUIRES_APPROVAL" || !cycle.quote) {
    throw new Error(`Cycle ${cycle.id} is not REQUIRES_APPROVAL with a live quote (currently ${cycle.state})`);
  }
  const now = deps.now();
  if (new Date(cycle.quote.expiresAt).getTime() <= now.getTime()) {
    deps.capStore.release(cycle.reservationId!);
    const reason = "Quote expired before it was approved — wait for the next scheduled cycle";
    const expired = transitionCycle(cycle, "EXPIRED", { reason, at: now.toISOString() });
    return { outcome: "EXPIRED", cycle: expired, reason };
  }

  const approved = transitionCycle(cycle, "AUTO_APPROVED", { at: now.toISOString() });
  return executeApprovedCycle(approved, cycle.quote, deps);
}

/**
 * The user's real "Skip this cycle" tap on a REQUIRES_APPROVAL cycle —
 * releases the cumulative-cap reservation decisionLoop.ts already made for
 * it (Section A.6), since the user chose not to spend that allocation.
 */
export function skipCycle(cycle: Cycle, deps: Pick<QuoteEngineDeps, "capStore" | "now">): Cycle {
  if (cycle.state !== "REQUIRES_APPROVAL") {
    throw new Error(`Cycle ${cycle.id} is not REQUIRES_APPROVAL (currently ${cycle.state})`);
  }
  if (cycle.reservationId) {
    deps.capStore.release(cycle.reservationId);
  }
  return transitionCycle(cycle, "SKIPPED", { reason: "User chose to skip this cycle", at: deps.now().toISOString() });
}
