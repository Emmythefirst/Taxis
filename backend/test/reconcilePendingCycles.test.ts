import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { insertCycle, getCycle } from "../src/persistence/cycles.js";
import { SqliteCapStore } from "../src/persistence/sqliteCapStore.js";
import { reconcilePendingCycles } from "../src/scheduler/reconcilePendingCycles.js";
import type { Cycle, ObligationEnvelope, Recipient } from "../src/domain/types.js";

/**
 * A cycle that reaches PENDING_CONFIRMATION (broadcast, no receipt observed
 * within the original send's timeout) previously just sat in EXECUTING
 * forever — nothing ever re-asked whether the receipt had landed. This is
 * the regression coverage for the fix: reconcilePendingCycles() re-queries
 * a stuck cycle's already-broadcast transaction and routes it to the exact
 * same settle()/release() outcome the original path would have reached.
 */

let db: Database.Database;
const NOW = new Date("2026-01-15T00:10:00.000Z");
const PERIOD = "2026-01";
const TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
  setUserWallet(db, "user_1", "wallet_1", "0x00000000000000000000000000000000000ee1");
  const recipient: Recipient = {
    id: "rcp_1",
    userId: "user_1",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  insertRecipient(db, recipient);
  const obligation: ObligationEnvelope = {
    id: "obl_1",
    userId: "user_1",
    recipientId: "rcp_1",
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd: 1000,
    cadence: { kind: "MONTHLY", dayOfMonth: 1 },
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  insertObligation(db, obligation);
});

/** Seeds a real RESERVED reservation and a cycle sitting in EXECUTING with
 *  a broadcast tx hash — exactly the state a PENDING_CONFIRMATION outcome
 *  leaves behind. `updatedAt` is set directly via raw SQL afterward since
 *  saveCycle()/insertCycle() always stamp real wall-clock time, not an
 *  injectable one — needed here to test the grace-window boundary itself. */
function seedStuckCycle(updatedAt: string): void {
  const capStore = new SqliteCapStore(db);
  capStore.initPeriod("obl_1", PERIOD, 1000);
  const reservation = capStore.reserve("obl_1", PERIOD, 201.5, "cyc_1");
  if (!reservation.ok) throw new Error("test setup: reservation should have succeeded");

  const cycle: Cycle = {
    id: "cyc_1",
    obligationId: "obl_1",
    dueAt: "2026-01-01T00:00:00.000Z",
    state: "EXECUTING",
    reservationId: reservation.reservationId,
    txHash: TX_HASH,
    history: [{ from: "AUTO_APPROVED", to: "EXECUTING", at: "2026-01-01T00:00:00.000Z" }],
  };
  insertCycle(db, cycle);
  db.prepare(`UPDATE cycles SET updated_at = ? WHERE id = ?`).run(updatedAt, cycle.id);
}

describe("reconcilePendingCycles", () => {
  it("settles a stuck cycle once its receipt confirms — same as the original path would have", async () => {
    seedStuckCycle("2026-01-15T00:00:00.000Z"); // 10 minutes before NOW — past any reasonable grace window

    const results = await reconcilePendingCycles({
      db,
      now: () => NOW,
      checkReceipt: async (hash) => {
        expect(hash).toBe(TX_HASH);
        return { confirmed: true, reverted: false };
      },
      graceMs: 30_000,
    });

    expect(results).toEqual([{ cycleId: "cyc_1", outcome: "SETTLED" }]);
    expect(getCycle(db, "cyc_1")?.state).toBe("SETTLED");

    const capStore = new SqliteCapStore(db);
    const snapshot = capStore.snapshot("obl_1", PERIOD);
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.spent).toBe(201.5);
  });

  it("fails and releases the reservation when the receipt confirms a revert", async () => {
    seedStuckCycle("2026-01-15T00:00:00.000Z");

    const results = await reconcilePendingCycles({
      db,
      now: () => NOW,
      checkReceipt: async () => ({ confirmed: true, reverted: true }),
      graceMs: 30_000,
    });

    expect(results).toEqual([{ cycleId: "cyc_1", outcome: "FAILED" }]);
    const cycle = getCycle(db, "cyc_1");
    expect(cycle?.state).toBe("FAILED");
    expect(cycle?.reason).toMatch(/reverted on-chain \(found on reconciliation\)/);

    const capStore = new SqliteCapStore(db);
    const snapshot = capStore.snapshot("obl_1", PERIOD);
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.spent).toBe(0); // released, not settled — never actually paid
  });

  it("leaves a still-unconfirmed cycle untouched — no guessing", async () => {
    seedStuckCycle("2026-01-15T00:00:00.000Z");

    const results = await reconcilePendingCycles({
      db,
      now: () => NOW,
      checkReceipt: async () => ({ confirmed: false, reverted: false }),
      graceMs: 30_000,
    });

    expect(results).toEqual([{ cycleId: "cyc_1", outcome: "STILL_PENDING" }]);
    expect(getCycle(db, "cyc_1")?.state).toBe("EXECUTING");

    const capStore = new SqliteCapStore(db);
    expect(capStore.snapshot("obl_1", PERIOD).reserved).toBe(201.5); // still reserved, untouched
  });

  it("respects the grace window — doesn't re-check a cycle updated too recently", async () => {
    seedStuckCycle("2026-01-15T00:09:45.000Z"); // 15s before NOW, inside a 30s grace window

    let checked = false;
    const results = await reconcilePendingCycles({
      db,
      now: () => NOW,
      checkReceipt: async () => {
        checked = true;
        return { confirmed: true, reverted: false };
      },
      graceMs: 30_000,
    });

    expect(results).toEqual([]);
    expect(checked).toBe(false);
    expect(getCycle(db, "cyc_1")?.state).toBe("EXECUTING");
  });
});
