import type { CapStore } from "./reservation.js";
import { transitionCycle } from "./cycleStateMachine.js";
import type { Cycle, ObligationEnvelope, Quote, Recipient } from "./types.js";

/**
 * The per-cycle decision loop — progress.md Section A.10. This does not
 * introduce new rules; it's the one function that runs every gate from
 * Sections A.3/A.6/A.9 in the documented order, so "what does the agent
 * actually do" has a single, auditable answer.
 */

export interface QuoteInputs {
  fxRate: number; // local currency per 1 AUSD, right now
  feeAgentAusd: number;
  feeNetworkAusd: number;
  availableBalanceAusd: number;
  period: string; // cumulative-cap bucket, e.g. "2026-09"
}

export interface DecisionDeps {
  capStore: CapStore;
  now: () => Date;
  sign: (quote: Omit<Quote, "signature">) => string;
  makeNonce: () => string;
}

export type DecisionOutcome =
  | { outcome: "SKIPPED"; cycle: Cycle; reason: string }
  | { outcome: "REQUIRES_APPROVAL"; cycle: Cycle; quote: Quote }
  | { outcome: "AUTO_APPROVED"; cycle: Cycle; quote: Quote };

export function runDecisionLoop(
  cycle: Cycle,
  envelope: ObligationEnvelope,
  recipient: Recipient,
  inputs: QuoteInputs,
  deps: DecisionDeps,
): DecisionOutcome {
  const now = deps.now();

  // Gate 1 (Section A.9): recipient must still be on the user's allowlist.
  if (recipient.status !== "ACTIVE" || recipient.id !== envelope.recipientId) {
    const skipped = transitionCycle(cycle, "SKIPPED", {
      reason: "Recipient is not on the active allowlist",
      at: now.toISOString(),
    });
    return { outcome: "SKIPPED", cycle: skipped, reason: skipped.reason! };
  }

  // Steps 3-4: compute required AUSD principal (Model C) + itemized fees.
  const ausdPrincipal = envelope.targetLocalAmount / inputs.fxRate;
  const totalAusd = ausdPrincipal + inputs.feeAgentAusd + inputs.feeNetworkAusd;

  // Step 6 (Section A.7): check-then-quote — never issue a quote the wallet
  // can't cover.
  if (inputs.availableBalanceAusd < totalAusd) {
    const skipped = transitionCycle(cycle, "SKIPPED", {
      reason: `Insufficient balance: need ${totalAusd.toFixed(4)} AUSD, have ${inputs.availableBalanceAusd.toFixed(4)}`,
      at: now.toISOString(),
    });
    return { outcome: "SKIPPED", cycle: skipped, reason: skipped.reason! };
  }

  // Step 5: is this inside the user's tolerance envelope (Model C)?
  const withinFxCeiling = ausdPrincipal <= envelope.maxAusdCost;
  const withinFeeCeiling = inputs.feeAgentAusd + inputs.feeNetworkAusd <= envelope.maxFeeAusd;
  const withinTolerance = withinFxCeiling && withinFeeCeiling;

  // Step 7: atomically reserve the cumulative-cap allocation. Also the sole
  // duplicate-execution guard (Section A.12) now that a recurring
  // obligation's Privy policy is durable rather than reattached fresh per
  // cycle — see reservation.ts header for why this can no longer rely on
  // any on-chain backstop.
  deps.capStore.initPeriod(envelope.id, inputs.period, envelope.cumulativeCapAusd);
  const reservation = deps.capStore.reserve(envelope.id, inputs.period, totalAusd, cycle.id);
  if (!reservation.ok) {
    const skipped = transitionCycle(cycle, "SKIPPED", {
      reason:
        reservation.reason === "DUPLICATE_CYCLE"
          ? "This cycle already has a reservation or has settled — refusing to execute it twice"
          : "Cumulative spending cap reservation failed for this period",
      at: now.toISOString(),
    });
    return { outcome: "SKIPPED", cycle: skipped, reason: skipped.reason! };
  }

  // Step 8: generate and sign the quote (recipient, amount, fee, expiry, nonce).
  const expiresAt = new Date(now.getTime() + envelope.quoteExpirySeconds * 1000).toISOString();
  const unsigned: Omit<Quote, "signature"> = {
    obligationId: envelope.id,
    cycleId: cycle.id,
    recipientAddress: recipient.payoutAddress,
    localAmount: envelope.targetLocalAmount,
    localCurrency: envelope.localCurrency,
    ausdAmount: totalAusd.toString(),
    fxRateLockedAt: now.toISOString(),
    fxRate: inputs.fxRate,
    feeAgentAusd: inputs.feeAgentAusd.toString(),
    feeNetworkAusd: inputs.feeNetworkAusd.toString(),
    nonce: deps.makeNonce(),
    issuedAt: now.toISOString(),
    expiresAt,
  };
  const quote: Quote = { ...unsigned, signature: deps.sign(unsigned) as `0x${string}` };

  let next = transitionCycle(cycle, "QUOTED", { at: now.toISOString() });
  next = { ...next, quote, reservationId: reservation.reservationId };
  next = transitionCycle(next, "FUNDS_RESERVED", { at: now.toISOString() });

  if (withinTolerance) {
    const approved = transitionCycle(next, "AUTO_APPROVED", { at: now.toISOString() });
    return { outcome: "AUTO_APPROVED", cycle: approved, quote };
  }

  const requiresApproval = transitionCycle(next, "REQUIRES_APPROVAL", {
    at: now.toISOString(),
    reason: !withinFxCeiling
      ? `FX cost ${ausdPrincipal.toFixed(4)} AUSD exceeds your ceiling of ${envelope.maxAusdCost} AUSD`
      : `Fee ${(inputs.feeAgentAusd + inputs.feeNetworkAusd).toFixed(4)} AUSD exceeds your ceiling of ${envelope.maxFeeAusd} AUSD`,
  });
  return { outcome: "REQUIRES_APPROVAL", cycle: requiresApproval, quote };
}
