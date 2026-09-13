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
