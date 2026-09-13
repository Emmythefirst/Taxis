import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { SqliteCapStore } from "../src/persistence/sqliteCapStore.js";

// Mirrors test/reservation.test.ts's scenarios exactly, against the real
// SQL-backed store instead of the in-memory one — proving the persisted
// implementation honors the same atomic-reservation and duplicate-cycle
// guarantees, not just that it compiles.

let db: Database.Database;
let store: SqliteCapStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new SqliteCapStore(db);
});

describe("SqliteCapStore (atomic reserve, real SQL)", () => {
  it("allows reservations up to the cap and rejects the one that would exceed it", () => {
    store.initPeriod("obl_1", "2026-09", 750);

    const a = store.reserve("obl_1", "2026-09", 500, "cycle_a");
    const b = store.reserve("obl_1", "2026-09", 250, "cycle_b");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(store.snapshot("obl_1", "2026-09").reserved).toBe(750);

    const c = store.reserve("obl_1", "2026-09", 1, "cycle_c");
    expect(c).toEqual({ ok: false, reason: "CAP_EXCEEDED" });
  });

  it("settle moves reserved -> spent; release frees the reservation", () => {
    store.initPeriod("obl_1", "2026-09", 750);

    const a = store.reserve("obl_1", "2026-09", 500, "cycle_a");
    if (!a.ok) throw new Error("expected reservation to succeed");
    store.settle(a.reservationId);
    expect(store.snapshot("obl_1", "2026-09")).toEqual({ cap: 750, spent: 500, reserved: 0 });

    const b = store.reserve("obl_1", "2026-09", 200, "cycle_b");
    if (!b.ok) throw new Error("expected reservation to succeed");
    store.release(b.reservationId);
    expect(store.snapshot("obl_1", "2026-09")).toEqual({ cap: 750, spent: 500, reserved: 0 });
  });

  it("refuses to reserve the same cycle twice, even when the cap has room", () => {
    store.initPeriod("obl_1", "2026-09", 750);

    const first = store.reserve("obl_1", "2026-09", 100, "cycle_x");
    expect(first.ok).toBe(true);

    const duplicateWhileActive = store.reserve("obl_1", "2026-09", 100, "cycle_x");
    expect(duplicateWhileActive).toEqual({ ok: false, reason: "DUPLICATE_CYCLE" });

    if (!first.ok) throw new Error("expected first reservation to succeed");
    store.settle(first.reservationId);

    const duplicateAfterSettle = store.reserve("obl_1", "2026-09", 100, "cycle_x");
    expect(duplicateAfterSettle).toEqual({ ok: false, reason: "DUPLICATE_CYCLE" });
  });

  it("allows a legitimate retry of the same cycle after a release", () => {
    store.initPeriod("obl_1", "2026-09", 750);

    const first = store.reserve("obl_1", "2026-09", 100, "cycle_x");
    if (!first.ok) throw new Error("expected first reservation to succeed");
    store.release(first.reservationId);

    const retry = store.reserve("obl_1", "2026-09", 100, "cycle_x");
    expect(retry.ok).toBe(true);
  });

  it("throws when reserving against a period that was never initialized", () => {
    expect(() => store.reserve("obl_never", "2026-09", 10, "cycle_x")).toThrow(/not initialized/);
  });

  it("is idempotent-safe to call initPeriod twice (does not reset an existing period)", () => {
    store.initPeriod("obl_1", "2026-09", 750);
    const a = store.reserve("obl_1", "2026-09", 500, "cycle_a");
    expect(a.ok).toBe(true);

    // Calling initPeriod again (e.g. a second decision-loop run in the same
    // period) must not wipe out the existing reserved/spent state.
    store.initPeriod("obl_1", "2026-09", 750);
    expect(store.snapshot("obl_1", "2026-09").reserved).toBe(500);
  });
});
