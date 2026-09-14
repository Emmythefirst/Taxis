/**
 * Persists the two distinct grant kinds (Section A.6/A.8): the everyday,
 * short-lived CYCLE grant, and the separate, independently-renewed
 * CONTINUITY grant used only for dead-man's-switch redirection. These are
 * tracked as rows here so the app knows what's currently live and when a
 * renewal prompt is due — the actual Privy-side attach/revoke/renew call is
 * always owner-gated and client-side (privy/policy.ts's header explains
 * why); this module is bookkeeping, not the actor.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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

interface GrantRow {
  id: string;
  obligation_id: string;
  kind: string;
  policy_id: string;
  agent_quorum_id: string;
  expires_at: string;
  status: string;
  created_at: string;
}

function rowToGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    obligationId: row.obligation_id,
    kind: row.kind as GrantKind,
    policyId: row.policy_id,
    agentQuorumId: row.agent_quorum_id,
    expiresAt: row.expires_at,
    status: row.status as GrantStatus,
    createdAt: row.created_at,
  };
}

export interface RecordGrantParams {
  obligationId: string;
  kind: GrantKind;
  policyId: string;
  agentQuorumId: string;
  expiresAt: string;
}

/** Records a grant Privy has already accepted (owner-signed, client-side) — never creates it on Privy's side. */
export function recordGrant(db: Database.Database, params: RecordGrantParams): Grant {
  const grant: Grant = { id: `grant_${randomUUID()}`, status: "ACTIVE", createdAt: new Date().toISOString(), ...params };
  db.prepare(
    `INSERT INTO grants (id, obligation_id, kind, policy_id, agent_quorum_id, expires_at, status, created_at)
     VALUES (@id, @obligationId, @kind, @policyId, @agentQuorumId, @expiresAt, @status, @createdAt)`,
  ).run(grant);
  return grant;
}

/** The current ACTIVE grant of a given kind for an obligation, if any (there should be at most one at a time). */
export function getActiveGrant(db: Database.Database, obligationId: string, kind: GrantKind): Grant | undefined {
  const row = db
    .prepare(
      `SELECT * FROM grants WHERE obligation_id = ? AND kind = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(obligationId, kind) as GrantRow | undefined;
  return row ? rowToGrant(row) : undefined;
}

export function listGrantsForObligation(db: Database.Database, obligationId: string): Grant[] {
  const rows = db
    .prepare(`SELECT * FROM grants WHERE obligation_id = ? ORDER BY created_at`)
    .all(obligationId) as GrantRow[];
  return rows.map(rowToGrant);
}

/** Marks the CYCLE (or, in principle, CONTINUITY) grant revoked — kill-switch's backend-sync half. See server.ts. */
export function revokeGrant(db: Database.Database, grantId: string): void {
  db.prepare(`UPDATE grants SET status = 'REVOKED' WHERE id = ?`).run(grantId);
}

export function expireGrant(db: Database.Database, grantId: string): void {
  db.prepare(`UPDATE grants SET status = 'EXPIRED' WHERE id = ?`).run(grantId);
}

export interface ActiveGrantWithObligation extends Grant {
  recipientAddress: string;
  maxAusdCost: number;
  maxFeeAusd: number;
}

/**
 * Every currently-active grant of a given kind across ALL of a user's
 * obligations, joined with what's needed to rebuild that obligation's rule
 * (engine/operationsPolicy.ts) — recipient address and cap. Only ACTIVE,
 * unexpired rows: a grant whose recorded expiry has already passed has
 * nothing worth re-including in a rebuilt policy (Privy would refuse it
 * anyway once past expiry).
 */
export function listActiveGrantsForUser(
  db: Database.Database,
  userId: string,
  kind: GrantKind,
  excludingObligationId?: string,
): ActiveGrantWithObligation[] {
  const rows = db
    .prepare(
      `SELECT g.*, r.payout_address AS recipient_address, o.max_ausd_cost, o.max_fee_ausd
       FROM grants g
       JOIN obligations o ON o.id = g.obligation_id
       JOIN recipients r ON r.id = o.recipient_id
       WHERE o.user_id = ? AND g.kind = ? AND g.status = 'ACTIVE' AND g.expires_at > ? AND o.id != ?
       ORDER BY g.created_at`,
    )
    .all(userId, kind, new Date().toISOString(), excludingObligationId ?? "") as Array<
    GrantRow & { recipient_address: string; max_ausd_cost: number; max_fee_ausd: number }
  >;
  return rows.map((row) => ({
    ...rowToGrant(row),
    recipientAddress: row.recipient_address,
    maxAusdCost: row.max_ausd_cost,
    maxFeeAusd: row.max_fee_ausd,
  }));
}

/**
 * After a combined-policy rebuild succeeds, every grant that was folded
 * into it now actually lives inside the NEW policy id, not whatever it was
 * created with — bookkeeping only, mirrors reality rather than driving it.
 * `excludingGrantId` skips the grant the caller is about to (or just did)
 * record separately with its own fresh row.
 */
export function retargetActiveGrantsPolicyId(db: Database.Database, userId: string, kind: GrantKind, newPolicyId: string, excludingGrantId?: string): void {
  db.prepare(
    `UPDATE grants SET policy_id = ?
     WHERE id IN (
       SELECT g.id FROM grants g JOIN obligations o ON o.id = g.obligation_id
       WHERE o.user_id = ? AND g.kind = ? AND g.status = 'ACTIVE'
     ) AND id != ?`,
  ).run(newPolicyId, userId, kind, excludingGrantId ?? "");
}
