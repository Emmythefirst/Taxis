/**
 * User persistence. `id` is the Privy user id itself (see schema.sql) —
 * real per-user wallet linkage (wallet_id/wallet_address) is resolved
 * server-side via privy/walletLookup.ts and cached here by /users/sync, so
 * execution code can look up "this obligation's owner's wallet" instead of
 * hardcoding one demo wallet for everyone.
 */

import type Database from "better-sqlite3";

interface UserRow {
  id: string;
  created_at: string;
  last_active_at: string | null;
  wallet_id: string | null;
  wallet_address: string | null;
  continuity_inactivity_days: number | null;
}

export interface UserRecord {
  id: string;
  createdAt: string;
  lastActiveAt: string | null;
  walletId: string | null;
  walletAddress: string | null;
  continuityInactivityDays: number | null;
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    continuityInactivityDays: row.continuity_inactivity_days,
  };
}

export function insertUser(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, created_at, last_active_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
    id,
    now,
    now,
  );
}

export function userExists(db: Database.Database, id: string): boolean {
  return db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id) !== undefined;
}

export function getUser(db: Database.Database, id: string): UserRecord | undefined {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

/** Proof-of-life: called on an explicit check-in or a routine grant renewal. */
export function touchUserActivity(db: Database.Database, id: string, at: Date = new Date()): void {
  db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(at.toISOString(), id);
}

/**
 * Caches the wallet Privy resolved for this user (walletLookup.ts). Always
 * called with server-verified data from Privy's own API, never with a
 * client-supplied walletId/address — a spoofed value here would let
 * execution code send from the wrong wallet.
 */
export function setUserWallet(db: Database.Database, id: string, walletId: string, walletAddress: string): void {
  db.prepare(`UPDATE users SET wallet_id = ?, wallet_address = ? WHERE id = ?`).run(walletId, walletAddress, id);
}

/** The user's own choice of dead-man's-switch inactivity threshold (Section A.8's 30/60/90-day chips), set during continuity setup. */
export function setContinuityInactivityDays(db: Database.Database, id: string, days: number): void {
  db.prepare(`UPDATE users SET continuity_inactivity_days = ? WHERE id = ?`).run(days, id);
}

/**
 * True once a user has been inactive for at least `thresholdDays`. A user
 * with no recorded activity at all is treated as inactive from their
 * creation date, not as "never inactive" — insertUser() always sets an
 * initial last_active_at, so this should only be null for rows created
 * before this column existed.
 */
export function isUserInactive(db: Database.Database, id: string, thresholdDays: number, asOf: Date = new Date()): boolean {
  const user = getUser(db, id);
  if (!user) throw new Error(`Unknown user: ${id}`);
  const reference = user.lastActiveAt ?? user.createdAt;
  const elapsedMs = asOf.getTime() - new Date(reference).getTime();
  return elapsedMs >= thresholdDays * 24 * 60 * 60 * 1000;
}
