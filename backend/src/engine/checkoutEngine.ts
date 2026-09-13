/**
 * Merchant checkout orchestration (Section A.2/A.6) — wires
 * domain/checkoutQuote.ts's pure quote logic to a real single-use Privy
 * policy and real execution. Two steps, matching the real product flow:
 *
 *   1. createCheckout() — computes and signs a quote, creates a
 *      single-use Privy policy (recipient=this merchant, cap=this exact
 *      amount, short expiry), and persists a PENDING_APPROVAL checkout.
 *      Returns the policyId for the frontend to use in its live,
 *      owner-signed "Approve payment" tap — this module never attaches
 *      the policy itself (same owner-gating reasoning as
 *      privy/policy.ts's createGrantPolicy).
 *   2. executeCheckout() — called once the frontend confirms the user
 *      approved (the policy is now live on the wallet's signer), executes
 *      the transfer via the agent key and persists the real outcome.
 *
 * No cumulative-cap reservation involved — a one-off checkout has no
 * rolling spend period the way a recurring obligation does.
 */

import { randomUUID } from "node:crypto";
import type { PrivyClient } from "@privy-io/node";
import { buildCheckoutQuote, type CheckoutQuoteInputs } from "../domain/checkoutQuote.js";
import { parseDecimalToBaseUnits } from "../domain/units.js";
import type { Checkout, Hex } from "../domain/types.js";
import { signQuote } from "../quoting/signing.js";
import { createGrantPolicy } from "../privy/policy.js";
import type { TransferExecutor } from "./quoteEngine.js";
import { getCheckout, insertCheckout, updateCheckoutStatus } from "../persistence/checkouts.js";
import type Database from "better-sqlite3";

export interface CreateCheckoutParams {
  userId: string;
  merchantAddress: Hex;
  localAmount: number;
  localCurrency: string;
}

export interface CreateCheckoutDeps {
  db: Database.Database;
  privy: PrivyClient;
  now: () => Date;
  makeNonce: () => string;
  quoteSigningPrivateKey: Hex;
  ausdAddress: Hex;
  ausdDecimals: number;
  fxRate: number;
  feeAgentAusd: number;
  feeNetworkAusd: number;
  availableBalanceAusd: number;
  /** Short window — minutes, not hours (Section A.3). */
  expirySeconds: number;
}

export type CreateCheckoutResult =
  | { outcome: "QUOTED"; checkout: Checkout; policyId: string }
  | { outcome: "INSUFFICIENT_BALANCE"; reason: string };

export async function createCheckout(deps: CreateCheckoutDeps, params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
  const checkoutId = `checkout_${randomUUID()}`;
  const inputs: CheckoutQuoteInputs = {
    merchantAddress: params.merchantAddress,
    localAmount: params.localAmount,
    localCurrency: params.localCurrency,
    fxRate: deps.fxRate,
    feeAgentAusd: deps.feeAgentAusd,
    feeNetworkAusd: deps.feeNetworkAusd,
    availableBalanceAusd: deps.availableBalanceAusd,
    expirySeconds: deps.expirySeconds,
  };

  const result = buildCheckoutQuote(checkoutId, inputs, {
    now: deps.now,
    makeNonce: deps.makeNonce,
    sign: (unsigned) => signQuote(unsigned, deps.quoteSigningPrivateKey),
  });

  if (result.outcome === "INSUFFICIENT_BALANCE") {
    return result;
  }

  const amountBaseUnits = parseDecimalToBaseUnits(result.quote.ausdAmount, deps.ausdDecimals);
  const expiresAtUnix = Math.floor(new Date(result.quote.expiresAt).getTime() / 1000);
  const grant = await createGrantPolicy(deps.privy, {
    ausdAddress: deps.ausdAddress,
    recipientAddress: params.merchantAddress,
    maxAmountBaseUnits: amountBaseUnits,
    expiresAtUnix,
    label: `Checkout ${checkoutId}`.slice(0, 49),
  });

  const checkout = insertCheckout(deps.db, {
    id: checkoutId,
    userId: params.userId,
    merchantAddress: params.merchantAddress,
    quote: result.quote,
    policyId: grant.policyId,
  });

  return { outcome: "QUOTED", checkout, policyId: grant.policyId };
}

export interface ExecuteCheckoutDeps {
  db: Database.Database;
  ausdDecimals: number;
  executor: TransferExecutor;
  now?: () => Date;
}

export type ExecuteCheckoutResult =
  | { outcome: "SETTLED"; txHash: string }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "PENDING_CONFIRMATION"; txHash: string };

export async function executeCheckout(deps: ExecuteCheckoutDeps, checkoutId: string): Promise<ExecuteCheckoutResult> {
  const checkout = getCheckout(deps.db, checkoutId);
  if (!checkout) {
    throw new Error(`Unknown checkout: ${checkoutId}`);
  }
  if (checkout.status !== "PENDING_APPROVAL") {
    throw new Error(`Checkout ${checkoutId} is not PENDING_APPROVAL (currently ${checkout.status})`);
  }
  const now = deps.now?.() ?? new Date();
  if (new Date(checkout.quote.expiresAt).getTime() <= now.getTime()) {
    updateCheckoutStatus(deps.db, checkoutId, "EXPIRED", { reason: "Quote expired before execution" });
    return { outcome: "FAILED", reason: "Quote expired before execution" };
  }

  const amountBaseUnits = parseDecimalToBaseUnits(checkout.quote.ausdAmount, deps.ausdDecimals);

  try {
    const result = await deps.executor.execute({ recipientAddress: checkout.merchantAddress, amountBaseUnits });

    if (!result.confirmed) {
      // Genuinely unknown outcome — same reasoning as quoteEngine.ts's
      // PENDING_CONFIRMATION: do not guess, do not mark FAILED (a retry
      // could double-pay if the original transaction still lands).
      return { outcome: "PENDING_CONFIRMATION", txHash: result.hash };
    }
    if (result.reverted) {
      updateCheckoutStatus(deps.db, checkoutId, "FAILED", { reason: `Transaction ${result.hash} was mined but reverted on-chain`, txHash: result.hash });
      return { outcome: "FAILED", reason: `Transaction ${result.hash} was mined but reverted on-chain` };
    }

    updateCheckoutStatus(deps.db, checkoutId, "SETTLED", { txHash: result.hash });
    return { outcome: "SETTLED", txHash: result.hash };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    updateCheckoutStatus(deps.db, checkoutId, "FAILED", { reason });
    return { outcome: "FAILED", reason };
  }
}
