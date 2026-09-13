import type Database from "better-sqlite3";
import type { Checkout, CheckoutQuote, CheckoutStatus, Hex } from "../domain/types.js";

interface CheckoutRow {
  id: string;
  user_id: string;
  merchant_address: string;
  status: string;
  quote_json: string;
  policy_id: string;
  reason: string | null;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCheckout(row: CheckoutRow): Checkout {
  return {
    id: row.id,
    userId: row.user_id,
    merchantAddress: row.merchant_address as Hex,
    status: row.status as CheckoutStatus,
    quote: JSON.parse(row.quote_json) as CheckoutQuote,
    reason: row.reason ?? undefined,
    txHash: row.tx_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertCheckoutParams {
  id: string;
  userId: string;
  merchantAddress: Hex;
  quote: CheckoutQuote;
  policyId: string;
}

export function insertCheckout(db: Database.Database, params: InsertCheckoutParams): Checkout {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO checkouts (id, user_id, merchant_address, status, quote_json, policy_id, created_at, updated_at)
     VALUES (@id, @userId, @merchantAddress, 'PENDING_APPROVAL', @quoteJson, @policyId, @createdAt, @updatedAt)`,
  ).run({ ...params, quoteJson: JSON.stringify(params.quote), createdAt: now, updatedAt: now });
  return { id: params.id, userId: params.userId, merchantAddress: params.merchantAddress, status: "PENDING_APPROVAL", quote: params.quote, createdAt: now, updatedAt: now };
}

export function getCheckout(db: Database.Database, id: string): Checkout | undefined {
  const row = db.prepare(`SELECT * FROM checkouts WHERE id = ?`).get(id) as CheckoutRow | undefined;
  return row ? rowToCheckout(row) : undefined;
}

export function getCheckoutPolicyId(db: Database.Database, id: string): string | undefined {
  const row = db.prepare(`SELECT policy_id FROM checkouts WHERE id = ?`).get(id) as { policy_id: string } | undefined;
  return row?.policy_id;
}

export function updateCheckoutStatus(
  db: Database.Database,
  id: string,
  status: CheckoutStatus,
  extra: { reason?: string; txHash?: string } = {},
): void {
  db.prepare(
    `UPDATE checkouts SET status = @status, reason = @reason, tx_hash = @txHash, updated_at = @updatedAt WHERE id = @id`,
  ).run({
    id,
    status,
    reason: extra.reason ?? null,
    txHash: extra.txHash ?? null,
    updatedAt: new Date().toISOString(),
  });
}
