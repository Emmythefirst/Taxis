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
  ausdAmount: string; // base-unit string (e.g. wei-equivalent for AUSD's decimals)
  fxRateLockedAt: string; // ISO timestamp
  fxRate: number; // local currency per 1 AUSD, at lock time
  feeAgentAusd: string; // base-unit string, itemized
  feeNetworkAusd: string; // base-unit string, itemized
  /** Unique per cycle — guarantees a quote can never execute twice. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signature?: Hex;
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
