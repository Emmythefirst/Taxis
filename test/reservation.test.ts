import { describe, expect, it } from "vitest";
import { CumulativeCapStore, NaiveReadThenWriteStore } from "../src/domain/reservation.js";

describe("CumulativeCapStore (atomic reserve)", () => {
  it("allows reservations up to the cap and rejects the one that would exceed it", () => {
    const store = new CumulativeCapStore();
    store.initPeriod("obl_1", "2026-09", 750);

    const a = store.reserve("obl_1", "2026-09", 500);
    const b = store.reserve("obl_1", "2026-09", 250);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(store.snapshot("obl_1", "2026-09").reserved).toBe(750);

    const c = store.reserve("obl_1", "2026-09", 1);
    expect(c).toEqual({ ok: false, reason: "CAP_EXCEEDED" });
  });

  it("holds the cap under concurrent reservation attempts (no read-then-write race)", async () => {
    const store = new CumulativeCapStore();
    store.initPeriod("obl_1", "2026-09", 750);

    // Two concurrent $500 cycles against a $750 cap — the naive
    // read-then-write pattern (see below) lets both through. The atomic
    // store must let exactly one through.
    const results = await Promise.all([
      Promise.resolve(store.reserve("obl_1", "2026-09", 500)),
      Promise.resolve(store.reserve("obl_1", "2026-09", 500)),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
    expect(store.snapshot("obl_1", "2026-09").reserved).toBe(500);
  });

  it("settle moves reserved -> spent; release frees the reservation", () => {
    const store = new CumulativeCapStore();
    store.initPeriod("obl_1", "2026-09", 750);

    const a = store.reserve("obl_1", "2026-09", 500);
    if (!a.ok) throw new Error("expected reservation to succeed");
    store.settle(a.reservationId);
    expect(store.snapshot("obl_1", "2026-09")).toEqual({ cap: 750, spent: 500, reserved: 0 });

    const b = store.reserve("obl_1", "2026-09", 200);
    if (!b.ok) throw new Error("expected reservation to succeed");
    store.release(b.reservationId);
    expect(store.snapshot("obl_1", "2026-09")).toEqual({ cap: 750, spent: 500, reserved: 0 });
  });
});

describe("NaiveReadThenWriteStore (demonstrates the bug the atomic store prevents)", () => {
  it("can blow past the cap when two reservations race the read-write gap", async () => {
    const store = new NaiveReadThenWriteStore();
    store.init("obl_1");

    const [a, b] = await Promise.all([
      store.reserve("obl_1", 500, 750),
      store.reserve("obl_1", 500, 750),
    ]);

    // Both reads happen before either write lands, so both are approved —
    // $1000 of real payments go out against a $750 cap. This is exactly the
    // failure mode progress.md Section A.6 calls out; it's why the real
    // implementation must be a single atomic UPDATE, not this pattern.
    // (The store's own bookkeeping even masks the breach: because both
    // writes are computed from the same stale read, the ledger shows only
    // 500 — a lost update on top of the over-cap approval.)
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(store.approvedAmounts.reduce((sum, x) => sum + x, 0)).toBeGreaterThan(750);
    expect(store.get("obl_1")).toBe(500);
  });
});
