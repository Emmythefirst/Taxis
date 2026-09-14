import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { listCyclesForObligation } from "../src/persistence/cycles.js";
import { runDueCycles, type MarketDataProvider, type RunDueCyclesDeps } from "../src/scheduler/runDueCycles.js";
import type { TransferExecutor } from "../src/engine/quoteEngine.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

/**
 * Regression test for a real bug a reviewer caught: `runDueCycles.ts`
 * computes the cumulative-cap `period` as a calendar MONTH
 * (`now.toISOString().slice(0,7)`) — a genuine rolling monthly aggregate
 * cap by design (Section A.6; the Explain screen's own checklist literally
 * says "Monthly spending limit not exceeded"). That's correct for a
 * MONTHLY-cadence obligation (one cycle per period), but the frontend's New
 * Payment form (pages/app/NewPayment.tsx) originally defaulted
 * `cumulativeCapAusd` to the SAME value as the per-cycle ceiling
 * (`maxAusdCost`) regardless of cadence. For a WEEKLY obligation, multiple
 * cycles land in the SAME calendar-month period — the first cycle would
 * consume the entire monthly allowance, and every subsequent cycle that
 * month would fail as SKIPPED ("cumulative cap reservation failed"),
 * forever, for the life of the obligation.
 */

const QUOTE_SIGNING_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
  setUserWallet(db, "user_1", "wallet_1", "0x00000000000000000000000000000000000ee1");
});

class FakeExecutor implements TransferExecutor {
  calls = 0;
  async execute() {
    this.calls++;
    return { hash: `0xdeadbeef${this.calls}`, confirmed: true, reverted: false };
  }
}

const market: MarketDataProvider = {
  getFxRate: () => 1500,
  getFees: () => ({ agentAusd: 1, networkAusd: 0.5 }),
};

function makeDeps(executor: TransferExecutor, now: () => Date): RunDueCyclesDeps {
  return {
    db,
    now,
    market,
    quoteSigningPrivateKey: QUOTE_SIGNING_PRIVATE_KEY,
    ausdDecimals: 6,
    executorFor: () => executor,
    getAvailableBalanceAusd: async () => 5000,
    checkReceipt: async () => ({ confirmed: false, reverted: false }),
  };
}

function seedWeeklyObligation(cumulativeCapAusd: number): void {
  const recipient: Recipient = {
    id: "rcp_1",
    userId: "user_1",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-09-01T00:00:00.000Z",
  };
  insertRecipient(db, recipient);
  // Matches what NewPayment.tsx actually sends for a WEEKLY payment:
  // 300000/1500 = 200 AUSD principal + 1.5 fees = 201.5 AUSD per cycle.
  const obligation: ObligationEnvelope = {
    id: "obl_1",
    userId: "user_1",
    recipientId: "rcp_1",
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd,
    cadence: { kind: "WEEKLY", dayOfWeek: 4 }, // Thursday, matches 2026-09-03
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: "2026-09-03T00:00:00.000Z", // due immediately
  };
  insertObligation(db, obligation);
}

describe("cumulative cap across multiple cycles in the same calendar month", () => {
  it("BUG (pre-fix default): a weekly obligation with cumulativeCapAusd == maxAusdCost only ever settles its first cycle of the month", async () => {
    seedWeeklyObligation(210); // the exact broken default NewPayment.tsx used to send
    const executor = new FakeExecutor();

    const week1 = await runDueCycles(makeDeps(executor, () => new Date("2026-09-03T12:00:00.000Z")));
    expect(week1[0]?.outcome).toBe("SETTLED");

    // Second weekly cycle, same calendar month (2026-09-10).
    const week2 = await runDueCycles(makeDeps(executor, () => new Date("2026-09-10T12:00:00.000Z")));
    expect(week2[0]?.outcome).toBe("SKIPPED");
    expect((week2[0]?.detail as { reason?: string })?.reason).toMatch(/cumulative/i);

    const cycles = listCyclesForObligation(db, "obl_1");
    expect(cycles.filter((c) => c.state === "SETTLED")).toHaveLength(1);
    expect(cycles.filter((c) => c.state === "SKIPPED")).toHaveLength(1);
  });

  it("FIX: sizing cumulativeCapAusd for the cadence (e.g. ~5x a weekly ceiling) lets multiple cycles settle within the same month", async () => {
    seedWeeklyObligation(210 * 5); // cadence-aware sizing — what NewPayment.tsx now sends
    const executor = new FakeExecutor();

    const week1 = await runDueCycles(makeDeps(executor, () => new Date("2026-09-03T12:00:00.000Z")));
    expect(week1[0]?.outcome).toBe("SETTLED");

    const week2 = await runDueCycles(makeDeps(executor, () => new Date("2026-09-10T12:00:00.000Z")));
    expect(week2[0]?.outcome).toBe("SETTLED");

    const week3 = await runDueCycles(makeDeps(executor, () => new Date("2026-09-17T12:00:00.000Z")));
    expect(week3[0]?.outcome).toBe("SETTLED");

    const cycles = listCyclesForObligation(db, "obl_1");
    expect(cycles.filter((c) => c.state === "SETTLED")).toHaveLength(3);
  });
});
