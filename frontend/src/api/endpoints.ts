import { api } from "./client";
import type { Cadence, Checkout, Grant, Hex, ObligationEnvelope, Recipient, Cycle } from "../types";

export interface SyncUserResult {
  userId: string;
  walletId: string | null;
  walletAddress: string | null;
  linked: boolean;
}

export function syncUser(userId: string): Promise<SyncUserResult> {
  return api.post<SyncUserResult>("/users/sync", { userId });
}

export function getBalance(userId: string): Promise<{ userId: string; ausdBalance: string }> {
  return api.get(`/users/${userId}/balance`);
}

export function listRecipients(userId: string): Promise<{ recipients: Recipient[] }> {
  return api.get(`/users/${userId}/recipients`);
}

export function createRecipient(userId: string, params: { label: string; payoutAddress: Hex; localCurrency: string }): Promise<{ recipient: Recipient }> {
  return api.post(`/users/${userId}/recipients`, params);
}

export function listObligations(userId: string): Promise<{ obligations: ObligationEnvelope[] }> {
  return api.get(`/users/${userId}/obligations`);
}

export interface CreateObligationParams {
  recipientId: string;
  targetLocalAmount: number;
  localCurrency: string;
  maxAusdCost: number;
  maxFeeAusd: number;
  cumulativeCapAusd: number;
  cadence: Cadence;
  quoteExpirySeconds: number;
}

export interface CreateObligationResult {
  obligation: ObligationEnvelope;
  policyId: string;
  expiresAtUnix: number;
  agentQuorumId: string;
}

export function createObligation(userId: string, params: CreateObligationParams): Promise<CreateObligationResult> {
  return api.post(`/users/${userId}/obligations`, params);
}

export function getObligation(obligationId: string): Promise<{ obligation: ObligationEnvelope }> {
  return api.get(`/obligations/${obligationId}`);
}

export function listCycles(obligationId: string): Promise<{ cycles: Cycle[] }> {
  return api.get(`/obligations/${obligationId}/cycles`);
}

export function listGrants(obligationId: string): Promise<{ grants: Grant[] }> {
  return api.get(`/obligations/${obligationId}/grants`);
}

export interface RenewObligationResult {
  obligation: ObligationEnvelope;
  policyId: string;
  expiresAtUnix: number;
  agentQuorumId: string;
}

export function renewObligation(obligationId: string): Promise<RenewObligationResult> {
  return api.post(`/obligations/${obligationId}/renew`);
}

export function recordGrant(
  obligationId: string,
  params: { policyId: string; expiresAtUnix: number; kind?: "CYCLE" | "CONTINUITY" },
): Promise<{ grant: unknown }> {
  return api.post(`/obligations/${obligationId}/grant`, params);
}

export function approveCycle(obligationId: string, cycleId: string): Promise<{ outcome: string; cycle: Cycle } & Record<string, unknown>> {
  return api.post(`/obligations/${obligationId}/cycles/${cycleId}/approve`);
}

export function skipCycle(obligationId: string, cycleId: string): Promise<{ cycle: Cycle }> {
  return api.post(`/obligations/${obligationId}/cycles/${cycleId}/skip`);
}

export function killSwitch(obligationId: string, userId: string): Promise<{ obligationId: string; revokedGrantId: string | null; status: string }> {
  return api.post(`/obligations/${obligationId}/kill-switch`, undefined, userId);
}

export function checkIn(userId: string): Promise<{ userId: string; lastActiveAt: string }> {
  return api.post(`/users/${userId}/check-in`, undefined, userId);
}

export function listCheckouts(userId: string): Promise<{ checkouts: Checkout[] }> {
  return api.get(`/users/${userId}/checkouts`);
}

export type CreateCheckoutResult =
  | { outcome: "QUOTED"; checkout: Checkout; policyId: string; agentQuorumId: string }
  | { outcome: "INSUFFICIENT_BALANCE"; reason: string };

export function createCheckoutQuote(params: { userId: string; merchantAddress: Hex; localAmount: number; localCurrency: string }): Promise<CreateCheckoutResult> {
  return api.post("/checkout/quote", params);
}

export type ExecuteCheckoutResult =
  | { outcome: "SETTLED"; txHash: string }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "PENDING_CONFIRMATION"; txHash: string };

export function executeCheckout(checkoutId: string): Promise<ExecuteCheckoutResult> {
  return api.post(`/checkout/${checkoutId}/execute`);
}

export interface ContinuityStatus {
  configured: boolean;
  backupRecipientId?: string;
  inactivityThresholdDays?: number;
  expiresAt?: string;
}

export function getContinuityStatus(userId: string): Promise<ContinuityStatus> {
  return api.get(`/users/${userId}/continuity`);
}

export interface SetupContinuityResult {
  policyId: string;
  expiresAtUnix: number;
  continuityQuorumId: string;
  obligationIds: string[];
}

export function setupContinuity(userId: string, params: { backupRecipientId: string; inactivityThresholdDays: number }): Promise<SetupContinuityResult> {
  return api.post(`/users/${userId}/continuity`, params);
}

export function recordContinuityGrant(userId: string, params: { policyId: string; expiresAtUnix: number; inactivityThresholdDays: number }): Promise<{ configured: boolean; obligationIds: string[] }> {
  return api.post(`/users/${userId}/continuity/grant`, params);
}
