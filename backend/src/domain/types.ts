/**
 * Core domain types for Taxis. See progress.md Section A.3 (Trust Layer) and
 * A.9-10 (execution gates / decision loop) for the spec these types encode.
 */

export type Hex = `0x${string}`;

export interface Recipient {
  id: string;
  userId: string;
  label: string;
  /** Resolved exact payout address — never a name/label at execution time. */
  payoutAddress: Hex;
  localCurrency: string; // ISO 4217, e.g. "NGN"
  status: "ACTIVE" | "REVOKED";
  addedAt: string; // ISO timestamp
}

/**
 * FX risk ownership: Model C (tolerance envelope). The user fixes the target
 * local-currency amount and a ceiling on AUSD cost; fee is itemized and
 * capped separately. See progress.md Section A.3.
 */
export interface ObligationEnvelope {
  id: string;
  userId: string;
  recipientId: string;
  targetLocalAmount: number;
  localCurrency: string;
  /** Ceiling on the FX-driven AUSD principal cost (excludes fee). */
  maxAusdCost: number;
  /** Ceiling on the itemized agent + network fee, in AUSD. */
  maxFeeAusd: number;
  /**
   * Cumulative/rolling-period spend cap (Section A.6) — distinct from
   * maxAusdCost. maxAusdCost/maxFeeAusd gate whether a single cycle's quote
   * is auto-approved vs REQUIRES_APPROVAL; cumulativeCapAusd is the backstop
   * enforced via atomic reservation against a period's aggregate spend
   * (e.g. a duplicate CRE trigger producing a second cycle in the same
   * period must not double-spend even though each individual quote looks
   * fine on its own).
   */
  cumulativeCapAusd: number;
  cadence: Cadence;
  /** Per-quote validity window once issued. Minutes, not hours. */
  quoteExpirySeconds: number;
  status: "ACTIVE" | "PAUSED" | "CANCELLED";
  createdAt: string;
  /**
   * Dead-man's-switch continuity target (Section A.8) — the recipient
   * obligations redirect to on sustained user inactivity. Optional: not
   * every obligation opts into continuity. Setting this alone authorizes
   * nothing — redirection also requires a separate, independently-renewed
   * CONTINUITY-kind grant to actually exist (see persistence/grants.ts).
   */
  backupRecipientId?: string;
}

export type Cadence =
  | { kind: "WEEKLY"; dayOfWeek: number } // 0 = Sunday
  | { kind: "BIWEEKLY"; dayOfWeek: number }
  | { kind: "MONTHLY"; dayOfMonth: number };

/**
 * A signed, expiring quote for one specific cycle. Every field is bound
 * together and signed as a unit — see progress.md Section A.3.
 */
export interface Quote {
  obligationId: string;
  cycleId: string;
  recipientAddress: Hex;
  localAmount: number;
  localCurrency: string;
  /**
   * Decimal AUSD amount, human-readable (e.g. "201.5") — NOT base units.
   * decisionLoop.ts computes this from FX rate + fees, which are naturally
   * human-scale; it deliberately doesn't know AUSD's on-chain decimals.
   * The execution layer converts this to base units at send time via
   * parseDecimalToBaseUnits() (units.ts) — never via float multiplication,
   * which can misround real money amounts.
   */
  ausdAmount: string;
  fxRateLockedAt: string; // ISO timestamp
  fxRate: number; // local currency per 1 AUSD, at lock time
  // Decimal AUSD, human-readable (e.g. "1"/"0.5") — same convention as
  // ausdAmount above, not base units. Itemized: shown separately in the
  // explainability screen (Section A.11), never bundled into one total.
  // Not separately transferred on-chain today — ausdAmount already
  // includes both fees; these fields exist for display/audit.
  feeAgentAusd: string;
  feeNetworkAusd: string;
  /** Unique per cycle — guarantees a quote can never execute twice. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signature?: Hex;
}

/**
 * A signed, expiring quote for a one-off merchant checkout (Section A.2 —
 * committed scope regardless of milestone sequencing). Deliberately
 * separate from `Quote`: checkout has no cadence, no cumulative-cap period,
 * and no pre-existing recipient allowlist entry — the live "Approve
 * payment" tap at purchase time (Section A.6) IS the authorization for
 * that specific merchant address, each time, rather than a durable grant.
 */
export interface CheckoutQuote {
  checkoutId: string;
  merchantAddress: Hex;
  localAmount: number;
  localCurrency: string;
  /** Decimal AUSD, human-readable — same convention as Quote.ausdAmount. */
  ausdAmount: string;
  fxRateLockedAt: string;
  fxRate: number;
  feeAgentAusd: string;
  feeNetworkAusd: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signature?: Hex;
}

export const CHECKOUT_STATUSES = [
  "PENDING_APPROVAL",
  "SETTLED",
  "FAILED",
  "EXPIRED",
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export interface Checkout {
  id: string;
  userId: string;
  merchantAddress: Hex;
  status: CheckoutStatus;
  quote: CheckoutQuote;
  reason?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

export const CYCLE_STATES = [
  "PENDING_QUOTE",
  "QUOTED",
  "FUNDS_RESERVED",
  "AUTO_APPROVED",
  "REQUIRES_APPROVAL",
  "EXECUTING",
  "SETTLED",
  "EXPIRED",
  "FAILED",
  "SKIPPED",
] as const;

export type CycleState = (typeof CYCLE_STATES)[number];

export interface CycleHistoryEntry {
  from: CycleState | null;
  to: CycleState;
  at: string;
  reason?: string;
}

export interface Cycle {
  id: string;
  obligationId: string;
  dueAt: string;
  state: CycleState;
  quote?: Quote;
  reservationId?: string;
  /** Populated on SKIPPED/FAILED so the user is never left guessing. */
  reason?: string;
  history: CycleHistoryEntry[];
}
