/**
 * Merchant checkout's quote step (Section A.2/A.6) — deliberately NOT
 * decisionLoop.ts reused with different inputs. A checkout has no cadence,
 * no cumulative-cap rolling period, and no pre-existing recipient allowlist
 * entry to check against: the live "Approve payment" tap at purchase time
 * IS the authorization for that specific merchant address, this one time.
 * There is also no AUTO_APPROVED/REQUIRES_APPROVAL branch the way a
 * recurring obligation has one — the user is live and about to approve
 * (or not) by construction, so this only has two outcomes: a quote to show
 * them, or "can't afford it" (check-then-quote, Section A.7 — never issue a
 * quote the wallet can't cover).
 */

import type { CheckoutQuote, Hex } from "./types.js";

export interface CheckoutQuoteInputs {
  merchantAddress: Hex;
  localAmount: number;
  localCurrency: string;
  fxRate: number;
  feeAgentAusd: number;
  feeNetworkAusd: number;
  availableBalanceAusd: number;
  /** Short window — minutes, not hours (Section A.3). */
  expirySeconds: number;
}

export interface CheckoutQuoteDeps {
  now: () => Date;
  sign: (unsigned: Omit<CheckoutQuote, "signature">) => Hex;
  makeNonce: () => string;
}

export type CheckoutQuoteResult =
  | { outcome: "QUOTED"; quote: CheckoutQuote }
  | { outcome: "INSUFFICIENT_BALANCE"; reason: string };

export function buildCheckoutQuote(
  checkoutId: string,
  inputs: CheckoutQuoteInputs,
  deps: CheckoutQuoteDeps,
): CheckoutQuoteResult {
  const ausdPrincipal = inputs.localAmount / inputs.fxRate;
  const totalAusd = ausdPrincipal + inputs.feeAgentAusd + inputs.feeNetworkAusd;

  if (inputs.availableBalanceAusd < totalAusd) {
    return {
      outcome: "INSUFFICIENT_BALANCE",
      reason: `Insufficient balance: need ${totalAusd.toFixed(4)} AUSD, have ${inputs.availableBalanceAusd.toFixed(4)}`,
    };
  }

  const now = deps.now();
  const unsigned: Omit<CheckoutQuote, "signature"> = {
    checkoutId,
    merchantAddress: inputs.merchantAddress,
    localAmount: inputs.localAmount,
    localCurrency: inputs.localCurrency,
    ausdAmount: totalAusd.toString(),
    fxRateLockedAt: now.toISOString(),
    fxRate: inputs.fxRate,
    feeAgentAusd: inputs.feeAgentAusd.toString(),
    feeNetworkAusd: inputs.feeNetworkAusd.toString(),
    nonce: deps.makeNonce(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + inputs.expirySeconds * 1000).toISOString(),
  };

  return { outcome: "QUOTED", quote: { ...unsigned, signature: deps.sign(unsigned) } };
}
