-- Taxis persistence schema. Mirrors domain/types.ts exactly; JSON columns
-- (cadence_json, quote_json, history_json) hold serialized domain unions
-- that don't map cleanly to flat SQL columns.

CREATE TABLE IF NOT EXISTS users (
  -- This IS the Privy user id (usePrivy().user.id client-side) — not a
  -- separate app-generated id. There is exactly one Privy identity per
  -- Taxis user, so a second id column would only be a redundant mapping
  -- to keep in sync.
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- Dead-man's-switch input (Section A.8). Updated on an explicit check-in
  -- or a routine grant renewal — either is a valid proof-of-life signal.
  last_active_at TEXT,
  -- Resolved server-side from Privy (privy/walletLookup.ts) via /users/sync,
  -- never trusted from client input — this is what lets execution code
  -- (runDueCycles, checkoutEngine) act on THIS user's own embedded wallet
  -- instead of a single hardcoded demo wallet. Both null until the first
  -- successful sync.
  wallet_id TEXT,
  wallet_address TEXT,
  -- Dead-man's-switch (Section A.8) inactivity threshold, chosen by the
  -- user during continuity setup (the design's 30/60/90-day chips) — NULL
  -- until they've set it up, in which case runDueCycles falls back to the
  -- server-wide DEAD_MAN_SWITCH_INACTIVITY_DAYS default.
  continuity_inactivity_days INTEGER
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  payout_address TEXT NOT NULL,
  local_currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON recipients(user_id);

CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  target_local_amount REAL NOT NULL,
  local_currency TEXT NOT NULL,
  max_ausd_cost REAL NOT NULL,
  max_fee_ausd REAL NOT NULL,
  cumulative_cap_ausd REAL NOT NULL,
  cadence_json TEXT NOT NULL,
  quote_expiry_seconds INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  created_at TEXT NOT NULL,
  -- Dead-man's-switch continuity target (Section A.8). Nullable — not every
  -- obligation opts into continuity. Redirection only actually happens if
  -- this is set AND an ACTIVE CONTINUITY-kind grant exists (see grants
  -- table) — the mere presence of a backup recipient id here authorizes
  -- nothing on its own.
  backup_recipient_id TEXT REFERENCES recipients(id)
);
CREATE INDEX IF NOT EXISTS idx_obligations_user ON obligations(user_id);
CREATE INDEX IF NOT EXISTS idx_obligations_status ON obligations(status);

-- Section A.6 corrected model: a durable per-cycle-window Privy grant
-- (recipient + cap + expiry), never a fresh single-use policy per cycle.
-- Tracked here so the app knows when a grant is approaching expiry and a
-- renewal prompt (Section A.4 step 6) is due.
--
-- `kind` distinguishes the everyday short-lived CYCLE grant from a
-- separate, independently-renewed CONTINUITY grant (Section A.8) used only
-- for dead-man's-switch redirection. These are deliberately NOT the same
-- grant, and not even the same signer — see Section A.8 for why stacking
-- them on one signer's policy list was rejected (undocumented AND/OR
-- semantics for multiple policy ids on one signer).
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  kind TEXT NOT NULL DEFAULT 'CYCLE' CHECK (kind IN ('CYCLE', 'CONTINUITY')),
  policy_id TEXT NOT NULL,
  agent_quorum_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_obligation ON grants(obligation_id, kind);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,
  quote_json TEXT,
  reservation_id TEXT,
  reason TEXT,
  history_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_obligation ON cycles(obligation_id);
CREATE INDEX IF NOT EXISTS idx_cycles_state_due ON cycles(state, due_at);

-- Backs domain/reservation.ts's CapStore contract (see sqliteCapStore.ts).
CREATE TABLE IF NOT EXISTS cap_periods (
  obligation_id TEXT NOT NULL,
  period TEXT NOT NULL,
  cap REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  reserved REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (obligation_id, period)
);

-- Merchant checkout (Section A.2/A.6) — a one-off purchase, deliberately
-- NOT modeled as an obligation/cycle: no cadence, no cumulative-cap period,
-- no pre-existing recipient allowlist entry. `quote_json` holds the signed
-- CheckoutQuote; `policy_id` is the single-use Privy policy created for
-- this specific merchant address + amount + short expiry.
CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  merchant_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'SETTLED', 'FAILED', 'EXPIRED')),
  quote_json TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkouts_user ON checkouts(user_id);

-- Multiple rows per cycle_id are legitimate over time (e.g. one RELEASED
-- row from a failed attempt, then a later RESERVED row from a genuine
-- retry) — no UNIQUE constraint on cycle_id. The guard against replaying an
-- already-reserved-or-settled cycle is enforced in application code
-- (sqliteCapStore.ts's reserve()), not by a schema constraint here.
CREATE TABLE IF NOT EXISTS cap_reservations (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL,
  period TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cap_reservations_cycle ON cap_reservations(cycle_id);
