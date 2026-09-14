import type Database from "better-sqlite3";
import type { ObligationEnvelope } from "../domain/types.js";

interface ObligationRow {
  id: string;
  user_id: string;
  recipient_id: string;
  target_local_amount: number;
  local_currency: string;
  max_ausd_cost: number;
  max_fee_ausd: number;
  cumulative_cap_ausd: number;
  cadence_json: string;
  quote_expiry_seconds: number;
  status: string;
  created_at: string;
  backup_recipient_id: string | null;
}

function rowToObligation(row: ObligationRow): ObligationEnvelope {
  return {
    id: row.id,
    userId: row.user_id,
    recipientId: row.recipient_id,
    targetLocalAmount: row.target_local_amount,
    localCurrency: row.local_currency,
    maxAusdCost: row.max_ausd_cost,
    maxFeeAusd: row.max_fee_ausd,
    cumulativeCapAusd: row.cumulative_cap_ausd,
    cadence: JSON.parse(row.cadence_json),
    quoteExpirySeconds: row.quote_expiry_seconds,
    status: row.status as ObligationEnvelope["status"],
    createdAt: row.created_at,
    backupRecipientId: row.backup_recipient_id ?? undefined,
  };
}

export function insertObligation(db: Database.Database, obligation: ObligationEnvelope): void {
  db.prepare(
    `INSERT INTO obligations
       (id, user_id, recipient_id, target_local_amount, local_currency, max_ausd_cost,
        max_fee_ausd, cumulative_cap_ausd, cadence_json, quote_expiry_seconds, status, created_at,
        backup_recipient_id)
     VALUES
       (@id, @userId, @recipientId, @targetLocalAmount, @localCurrency, @maxAusdCost,
        @maxFeeAusd, @cumulativeCapAusd, @cadenceJson, @quoteExpirySeconds, @status, @createdAt,
        @backupRecipientId)`,
  ).run({
    ...obligation,
    cadenceJson: JSON.stringify(obligation.cadence),
    backupRecipientId: obligation.backupRecipientId ?? null,
  });
}

export function getObligation(db: Database.Database, id: string): ObligationEnvelope | undefined {
  const row = db.prepare(`SELECT * FROM obligations WHERE id = ?`).get(id) as ObligationRow | undefined;
  return row ? rowToObligation(row) : undefined;
}

export function listActiveObligations(db: Database.Database): ObligationEnvelope[] {
  const rows = db.prepare(`SELECT * FROM obligations WHERE status = 'ACTIVE' ORDER BY created_at`).all() as ObligationRow[];
  return rows.map(rowToObligation);
}

export function listObligationsForUser(db: Database.Database, userId: string): ObligationEnvelope[] {
  const rows = db.prepare(`SELECT * FROM obligations WHERE user_id = ? ORDER BY created_at`).all(userId) as ObligationRow[];
  return rows.map(rowToObligation);
}

export function updateObligationStatus(db: Database.Database, id: string, status: ObligationEnvelope["status"]): void {
  db.prepare(`UPDATE obligations SET status = ? WHERE id = ?`).run(status, id);
}

export function setBackupRecipient(db: Database.Database, id: string, backupRecipientId: string | null): void {
  db.prepare(`UPDATE obligations SET backup_recipient_id = ? WHERE id = ?`).run(backupRecipientId, id);
}

export interface ActiveObligationWithBackup {
  obligationId: string;
  backupRecipientAddress: string;
  maxAusdCost: number;
  maxFeeAusd: number;
}

/**
 * Every currently-ACTIVE obligation that has a backup recipient configured,
 * joined with what's needed to build that obligation's continuity rule
 * (engine/continuityPolicy.ts) — the BACKUP recipient's address (not the
 * primary one), and the same cap the day-to-day grant uses.
 */
export function listActiveObligationsWithBackupForUser(db: Database.Database, userId: string): ActiveObligationWithBackup[] {
  const rows = db
    .prepare(
      `SELECT o.id AS obligation_id, r.payout_address AS backup_recipient_address, o.max_ausd_cost, o.max_fee_ausd
       FROM obligations o
       JOIN recipients r ON r.id = o.backup_recipient_id
       WHERE o.user_id = ? AND o.status = 'ACTIVE' AND o.backup_recipient_id IS NOT NULL`,
    )
    .all(userId) as Array<{ obligation_id: string; backup_recipient_address: string; max_ausd_cost: number; max_fee_ausd: number }>;
  return rows.map((row) => ({
    obligationId: row.obligation_id,
    backupRecipientAddress: row.backup_recipient_address,
    maxAusdCost: row.max_ausd_cost,
    maxFeeAusd: row.max_fee_ausd,
  }));
}
