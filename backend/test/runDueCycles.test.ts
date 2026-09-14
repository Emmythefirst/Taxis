import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet, touchUserActivity } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation, setBackupRecipient } from "../src/persistence/obligations.js";
import { recordGrant } from "../src/persistence/grants.js";
import { listCyclesForObligation } from "../src/persistence/cycles.js";
import { runDueCycles, type MarketDataProvider, type RunDueCyclesDeps } from "../src/scheduler/runDueCycles.js";
import type { TransferExecutor } from "../src/engine/quoteEngine.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

const QUOTE_SIGNING_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
  setUserWallet(db, "user_1", "wallet_1", "0x00000000000000000000000000000000000ee1");
});

function seedObligation(overrides: Partial<ObligationEnvelope> = {}): void {
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
    ...overrides,
  };
  insertObligation(db, obligation);
}

class FakeExecutor implements TransferExecutor {
  calls: Array<{ recipientAddress: string; amountBaseUnits: bigint }> = [];
  async execute(params: { recipientAddress: `0x${string}`; amountBaseUnits: bigint }) {
    this.calls.push(params);
    return { hash: "0xdeadbeef", confirmed: true, reverted: false };
  }
}

const market: MarketDataProvider = {
  getFxRate: () => 1500,
  getFees: () => ({ agentAusd: 1, networkAusd: 0.5 }),
};

function makeDeps(executor: TransferExecutor, availableBalanceAusd = 5000): RunDueCyclesDeps {
  return {
    db,
    now: () => new Date("2026-01-15T00:00:00.000Z"),
    market,
    quoteSigningPrivateKey: QUOTE_SIGNING_PRIVATE_KEY,
    ausdDecimals: 6,
    executorFor: () => executor,
    getAvailableBalanceAusd: async () => availableBalanceAusd,
    // Not what this suite exercises — see reconcilePendingCycles.test.ts —
    // so nothing here ever leaves a cycle stuck without a receipt anyway.
    checkReceipt: async () => ({ confirmed: false, reverted: false }),
  };
}

describe("runDueCycles", () => {
  it("generates a due cycle, runs it through the real quote engine, and persists SETTLED", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" }); // MONTHLY dayOfMonth=1, due Jan 1
    const executor = new FakeExecutor();

    const results = await runDueCycles(makeDeps(executor));

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("SETTLED");
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.amountBaseUnits).toBe(201_500_000n); // 200 AUSD + 1.5 fees, at 6 decimals

    const persisted = listCyclesForObligation(db, "obl_1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.state).toBe("SETTLED");
  });

  it("does nothing when no obligation is actually due yet", async () => {
    seedObligation({ createdAt: "2026-06-15T00:00:00.000Z" }); // not due until July 1
    const executor = new FakeExecutor();

    const results = await runDueCycles(makeDeps(executor));

    expect(results).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });

  it("persists REQUIRES_APPROVAL without calling the executor when FX drift exceeds tolerance", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    const executor = new FakeExecutor();
    const overTolerance: MarketDataProvider = { ...market, getFxRate: () => 1300 }; // pushes cost over the 210 ceiling

    const results = await runDueCycles({ ...makeDeps(executor), market: overTolerance });

    expect(results[0]?.outcome).toBe("REQUIRES_APPROVAL");
    expect(executor.calls).toHaveLength(0);
    expect(listCyclesForObligation(db, "obl_1")[0]?.state).toBe("REQUIRES_APPROVAL");
  });

  it("skips a due cycle when the wallet balance is insufficient, without calling the executor", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    const executor = new FakeExecutor();

    const results = await runDueCycles(makeDeps(executor, 10)); // far below the ~201.5 AUSD needed

    expect(results[0]?.outcome).toBe("SKIPPED");
    expect(executor.calls).toHaveLength(0);
  });

  it("leaves a due cycle untouched when its owner has no wallet linked yet", async () => {
    db = openDb(":memory:");
    insertUser(db, "user_1"); // deliberately no setUserWallet() call
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    const executor = new FakeExecutor();

    const results = await runDueCycles(makeDeps(executor));

    expect(results).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });

  it("does not re-process the same cycle on a second call in the same period", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    const executor = new FakeExecutor();
    const deps = makeDeps(executor);

    const first = await runDueCycles(deps);
    const second = await runDueCycles(deps);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(executor.calls).toHaveLength(1);
  });
});

describe("runDueCycles — dead-man's-switch redirection", () => {
  function seedBackupRecipient(): void {
    insertRecipient(db, {
      id: "rcp_backup",
      userId: "user_1",
      label: "Sister",
      payoutAddress: "0x000000000000000000000000000000000000bb",
      localCurrency: "NGN",
      status: "ACTIVE",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  function makeDepsWithContinuity(cycleExecutor: TransferExecutor, continuityExecutor: TransferExecutor): RunDueCyclesDeps {
    return {
      ...makeDeps(cycleExecutor),
      executorFor: (_walletId, kind) => (kind === "CONTINUITY" ? continuityExecutor : cycleExecutor),
      continuity: { inactivityThresholdDays: 90 },
    };
  }

  it("redirects to the backup recipient via the continuity executor when genuinely inactive with an active continuity grant", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    seedBackupRecipient();
    setBackupRecipient(db, "obl_1", "rcp_backup");
    recordGrant(db, { obligationId: "obl_1", kind: "CONTINUITY", policyId: "policy_continuity", agentQuorumId: "continuity_agent", expiresAt: "2030-01-01T00:00:00.000Z" });
    touchUserActivity(db, "user_1", new Date("2025-01-01T00:00:00.000Z")); // inactive for a full year relative to "now" (2026-01-15)

    const cycleExecutor = new FakeExecutor();
    const continuityExecutor = new FakeExecutor();

    const results = await runDueCycles(makeDepsWithContinuity(cycleExecutor, continuityExecutor));

    expect(results[0]?.outcome).toBe("SETTLED");
    expect(cycleExecutor.calls).toHaveLength(0);
    expect(continuityExecutor.calls).toHaveLength(1);
    expect(continuityExecutor.calls[0]?.recipientAddress).toBe("0x000000000000000000000000000000000000bb");
  });

  it("does NOT redirect when the user is still active, even with a backup recipient and continuity grant configured", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    seedBackupRecipient();
    setBackupRecipient(db, "obl_1", "rcp_backup");
    recordGrant(db, { obligationId: "obl_1", kind: "CONTINUITY", policyId: "policy_continuity", agentQuorumId: "continuity_agent", expiresAt: "2030-01-01T00:00:00.000Z" });
    touchUserActivity(db, "user_1", new Date("2026-01-10T00:00:00.000Z")); // active just 5 days ago

    const cycleExecutor = new FakeExecutor();
    const continuityExecutor = new FakeExecutor();

    const results = await runDueCycles(makeDepsWithContinuity(cycleExecutor, continuityExecutor));

    expect(results[0]?.outcome).toBe("SETTLED");
    expect(cycleExecutor.calls).toHaveLength(1);
    expect(cycleExecutor.calls[0]?.recipientAddress).toBe("0x000000000000000000000000000000000000aa"); // primary
    expect(continuityExecutor.calls).toHaveLength(0);
  });

  it("does NOT redirect when inactive but no CONTINUITY grant was ever set up", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    seedBackupRecipient();
    setBackupRecipient(db, "obl_1", "rcp_backup");
    touchUserActivity(db, "user_1", new Date("2025-01-01T00:00:00.000Z")); // inactive, but no continuity grant recorded

    const cycleExecutor = new FakeExecutor();
    const continuityExecutor = new FakeExecutor();

    const results = await runDueCycles(makeDepsWithContinuity(cycleExecutor, continuityExecutor));

    expect(results[0]?.outcome).toBe("SETTLED");
    expect(cycleExecutor.calls).toHaveLength(1); // fell back to the normal path
    expect(continuityExecutor.calls).toHaveLength(0);
  });

  it("does NOT redirect when the obligation has no backup recipient configured at all", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    touchUserActivity(db, "user_1", new Date("2025-01-01T00:00:00.000Z"));

    const cycleExecutor = new FakeExecutor();
    const continuityExecutor = new FakeExecutor();

    const results = await runDueCycles(makeDepsWithContinuity(cycleExecutor, continuityExecutor));

    expect(results[0]?.outcome).toBe("SETTLED");
    expect(cycleExecutor.calls).toHaveLength(1);
    expect(continuityExecutor.calls).toHaveLength(0);
  });

  it("does NOT redirect when the `continuity` deps are simply not configured, even if everything else qualifies", async () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });
    seedBackupRecipient();
    setBackupRecipient(db, "obl_1", "rcp_backup");
    recordGrant(db, { obligationId: "obl_1", kind: "CONTINUITY", policyId: "policy_continuity", agentQuorumId: "continuity_agent", expiresAt: "2030-01-01T00:00:00.000Z" });
    touchUserActivity(db, "user_1", new Date("2025-01-01T00:00:00.000Z"));

    const cycleExecutor = new FakeExecutor();
    const results = await runDueCycles(makeDeps(cycleExecutor)); // no `continuity` key at all

    expect(results[0]?.outcome).toBe("SETTLED");
    expect(cycleExecutor.calls).toHaveLength(1);
  });
});
