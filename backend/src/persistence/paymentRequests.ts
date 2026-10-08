import type Database from "better-sqlite3";
import type { Hex, PaymentRequest, PaymentRequestStatus } from "../domain/types.js";

interface PaymentRequestRow {
  id: string;
  requester_user_id: string;
  requester_address: string;
  local_amount: number;
  local_currency: string;
  memo: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  fulfilled_checkout_id: string | null;
}

function rowToPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  return {
    id: row.id,
    requesterUserId: row.requester_user_id,
    requesterAddress: row.requester_address as Hex,
    localAmount: row.local_amount,
    localCurrency: row.local_currency,
    memo: row.memo ?? undefined,
    status: row.status as PaymentRequestStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fulfilledCheckoutId: row.fulfilled_checkout_id ?? undefined,
  };
}

export interface InsertPaymentRequestParams {
  id: string;
  requesterUserId: string;
  requesterAddress: Hex;
  localAmount: number;
  localCurrency: string;
  memo?: string;
  expiresAt: string;
}

export function insertPaymentRequest(db: Database.Database, params: InsertPaymentRequestParams): PaymentRequest {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO payment_requests (id, requester_user_id, requester_address, local_amount, local_currency, memo, status, created_at, expires_at)
     VALUES (@id, @requesterUserId, @requesterAddress, @localAmount, @localCurrency, @memo, 'PENDING', @createdAt, @expiresAt)`,
  ).run({ ...params, memo: params.memo ?? null, createdAt: now });
  return {
    id: params.id,
    requesterUserId: params.requesterUserId,
    requesterAddress: params.requesterAddress,
    localAmount: params.localAmount,
    localCurrency: params.localCurrency,
    memo: params.memo,
    status: "PENDING",
    createdAt: now,
    expiresAt: params.expiresAt,
  };
}

export function getPaymentRequest(db: Database.Database, id: string): PaymentRequest | undefined {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE id = ?`).get(id) as PaymentRequestRow | undefined;
  return row ? rowToPaymentRequest(row) : undefined;
}

export function listPaymentRequestsForUser(db: Database.Database, userId: string): PaymentRequest[] {
  const rows = db.prepare(`SELECT * FROM payment_requests WHERE requester_user_id = ? ORDER BY created_at DESC`).all(userId) as PaymentRequestRow[];
  return rows.map(rowToPaymentRequest);
}

export function updatePaymentRequestStatus(
  db: Database.Database,
  id: string,
  status: PaymentRequestStatus,
  extra: { fulfilledCheckoutId?: string } = {},
): void {
  db.prepare(`UPDATE payment_requests SET status = @status, fulfilled_checkout_id = COALESCE(@fulfilledCheckoutId, fulfilled_checkout_id) WHERE id = @id`).run({
    id,
    status,
    fulfilledCheckoutId: extra.fulfilledCheckoutId ?? null,
  });
}
