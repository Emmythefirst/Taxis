/**
 * Minimal user persistence — just enough for other tables' foreign keys to
 * mean something, plus activity tracking for the dead-man's-switch
 * (Section A.8). Real user records (Privy user id, wallet linkage) wait
 * until real login exists; building that out now would be guessing at a
 * shape driven by the auth flow, not by anything confirmed yet.
 */

import type Database from "better-sqlite3";

interface UserRow {
  id: string;
  created_at: string;
  last_active_at: string | null;
}

export interface UserRecord {
  id: string;
  createdAt: string;
  lastActiveAt: string | null;
}

function rowToUser(row: UserRow): UserRecord {
  return { id: row.id, createdAt: row.created_at, lastActiveAt: row.last_active_at };
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
