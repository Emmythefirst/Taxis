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
  return db;
}
