/**
 * SQLite connection + schema setup. SQLite (via better-sqlite3, a
 * synchronous driver) rather than a hosted DB: zero external infra for a
 * hackathon build, and its synchronous execution model is exactly what
 * reservation.ts's atomic-reservation contract already assumes (see
 * sqliteCapStore.ts) — no separate connection-pool/async-interleaving
 * concerns to design around.
 *
 * better-sqlite3 is pinned to ^12.11.1, not the newer 13.x — 13.x requires
 * Node >=22 and segfaults immediately on Node 20 (confirmed by trying it),
 * which is this project's minimum supported version.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

export function openDb(path: string = process.env.TAXIS_DB_PATH ?? "./data/taxis.db"): Database.Database {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  migrate(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` only ever applies to a genuinely new table —
 * it does nothing for a column added to schema.sql after a real database
 * file already exists (e.g. this project's own dev data/taxis.db, holding
 * a real logged-in user's row from before continuity_inactivity_days
 * existed). No migration framework for a project this size; just an
 * idempotent "add the column if it isn't there yet" check per addition.
 */
function migrate(db: Database.Database): void {
  const userColumns = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  if (!userColumns.some((c) => c.name === "continuity_inactivity_days")) {
    db.exec(`ALTER TABLE users ADD COLUMN continuity_inactivity_days INTEGER`);
  }

  const cycleColumns = db.prepare(`PRAGMA table_info(cycles)`).all() as Array<{ name: string }>;
  if (!cycleColumns.some((c) => c.name === "tx_hash")) {
    db.exec(`ALTER TABLE cycles ADD COLUMN tx_hash TEXT`);
  }
}
