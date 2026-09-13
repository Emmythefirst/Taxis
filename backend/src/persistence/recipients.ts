import type Database from "better-sqlite3";
import type { Hex, Recipient } from "../domain/types.js";

interface RecipientRow {
  id: string;
  user_id: string;
  label: string;
  payout_address: string;
  local_currency: string;
  status: string;
  added_at: string;
}

function rowToRecipient(row: RecipientRow): Recipient {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    payoutAddress: row.payout_address as Hex,
    localCurrency: row.local_currency,
    status: row.status as Recipient["status"],
    addedAt: row.added_at,
  };
}

export function insertRecipient(db: Database.Database, recipient: Recipient): void {
  db.prepare(
    `INSERT INTO recipients (id, user_id, label, payout_address, local_currency, status, added_at)
     VALUES (@id, @userId, @label, @payoutAddress, @localCurrency, @status, @addedAt)`,
  ).run(recipient);
}

export function getRecipient(db: Database.Database, id: string): Recipient | undefined {
  const row = db.prepare(`SELECT * FROM recipients WHERE id = ?`).get(id) as RecipientRow | undefined;
  return row ? rowToRecipient(row) : undefined;
}

export function listRecipientsForUser(db: Database.Database, userId: string): Recipient[] {
  const rows = db.prepare(`SELECT * FROM recipients WHERE user_id = ? ORDER BY added_at`).all(userId) as RecipientRow[];
  return rows.map(rowToRecipient);
}

export function updateRecipientStatus(db: Database.Database, id: string, status: Recipient["status"]): void {
  db.prepare(`UPDATE recipients SET status = ? WHERE id = ?`).run(status, id);
}
