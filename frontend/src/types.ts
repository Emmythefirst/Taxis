/**
 * Mirrors backend/src/domain/types.ts field-for-field. No shared package
 * between frontend/backend in this monorepo, so this is hand-kept in sync —
 * acceptable for the size of this project, but if these two drift, the
 * backend's file is the source of truth.
 */

export type Hex = `0x${string}`;

export interface Recipient {
  id: string;
  userId: string;
  label: string;
  payoutAddress: Hex;
  localCurrency: string;
  status: "ACTIVE" | "REVOKED";
  addedAt: string;
}

export type Cadence = { kind: "WEEKLY"; dayOfWeek: number } | { kind: "BIWEEKLY"; dayOfWeek: number } | { kind: "MONTHLY"; dayOfMonth: number };

export interface ObligationEnvelope {
  id: string;
  userId: string;
  recipientId: string;
  targetLocalAmount: number;
  localCurrency: string;
  maxAusdCost: number;
  maxFeeAusd: number;
  cumulativeCapAusd: number;
  cadence: Cadence;
  quoteExpirySeconds: number;
  status: "ACTIVE" | "PAUSED" | "CANCELLED";
  createdAt: string;
  backupRecipientId?: string;
}

export interface Quote {
  obligationId: string;
  cycleId: string;
  recipientAddress: Hex;
  localAmount: number;
  localCurrency: string;
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

export interface CheckoutQuote {
  checkoutId: string;
  merchantAddress: Hex;
  localAmount: number;
  localCurrency: string;
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

export type CheckoutStatus = "PENDING_APPROVAL" | "SETTLED" | "FAILED" | "EXPIRED";

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

export type CycleState =
  | "PENDING_QUOTE"
  | "QUOTED"
  | "FUNDS_RESERVED"
  | "AUTO_APPROVED"
  | "REQUIRES_APPROVAL"
  | "EXECUTING"
  | "SETTLED"
  | "EXPIRED"
  | "FAILED"
  | "SKIPPED";

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
  reason?: string;
  /** Set once a transfer is broadcast (EXECUTING onward) — lets the UI link
   *  to a block explorer instead of just claiming "signed and ready" for a
   *  cycle that's actually already in flight or awaiting confirmation. */
  txHash?: string;
  history: CycleHistoryEntry[];
}

export type GrantKind = "CYCLE" | "CONTINUITY";
export type GrantStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface Grant {
  id: string;
  obligationId: string;
  kind: GrantKind;
  policyId: string;
  agentQuorumId: string;
  expiresAt: string;
  status: GrantStatus;
  createdAt: string;
}
