import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { listCyclesForObligation } from "../src/persistence/cycles.js";
import { generateDueCycles } from "../src/scheduler/generateDueCycles.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
});

function seedObligation(overrides: Partial<ObligationEnvelope> = {}): ObligationEnvelope {
  const recipient: Recipient = {
    id: overrides.recipientId ?? "rcp_1",
    userId: "user_1",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  if (!overrides.recipientId) insertRecipient(db, recipient);

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
  return obligation;
}

describe("generateDueCycles", () => {
  it("returns nothing when there are no obligations", () => {
    expect(generateDueCycles(db, new Date("2026-06-01T00:00:00.000Z"))).toEqual([]);
  });

  it("generates exactly one cycle for a freshly-due obligation with no prior cycles", () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });

    const generated = generateDueCycles(db, new Date("2026-01-15T00:00:00.000Z"));

    expect(generated).toHaveLength(1);
    expect(generated[0]?.dueAt).toBe("2026-01-01T00:00:00.000Z");

    const cycles = listCyclesForObligation(db, "obl_1");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.state).toBe("PENDING_QUOTE");
  });

  it("does not generate a cycle before the obligation's first due date", () => {
    seedObligation({ createdAt: "2026-06-15T00:00:00.000Z" }); // due dayOfMonth=1 -> next due is July 1

    const generated = generateDueCycles(db, new Date("2026-06-20T00:00:00.000Z"));
    expect(generated).toHaveLength(0);
  });

  it("catches up fully in one call when several periods were missed", () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" }); // MONTHLY, dayOfMonth=1

    const generated = generateDueCycles(db, new Date("2026-04-01T00:00:00.000Z"));

    // Jan 1, Feb 1, Mar 1, Apr 1 are all due by Apr 1 — all four should
    // appear in a single call, not just the next missed one.
    expect(generated.map((g) => g.dueAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]);
  });

  it("is idempotent — calling it again immediately creates no duplicates", () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });

    generateDueCycles(db, new Date("2026-01-15T00:00:00.000Z"));
    const second = generateDueCycles(db, new Date("2026-01-15T00:00:00.000Z"));

    expect(second).toHaveLength(0);
    expect(listCyclesForObligation(db, "obl_1")).toHaveLength(1);
  });

  it("anchors the next due date off the last cycle regardless of its outcome", () => {
    seedObligation({ createdAt: "2026-01-01T00:00:00.000Z" });

    generateDueCycles(db, new Date("2026-01-01T00:00:00.000Z")); // creates the Jan 1 cycle
    // Simulate time passing without the Jan cycle's payment outcome
    // mattering to scheduling — generation must not re-fire for January.
    const generated = generateDueCycles(db, new Date("2026-02-01T00:00:00.000Z"));

    expect(generated).toHaveLength(1);
    expect(generated[0]?.dueAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("handles multiple obligations independently", () => {
    seedObligation({ id: "obl_1", createdAt: "2026-01-01T00:00:00.000Z", cadence: { kind: "MONTHLY", dayOfMonth: 1 } });
    seedObligation({
      id: "obl_2",
      recipientId: "rcp_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      cadence: { kind: "WEEKLY", dayOfWeek: 4 }, // Thursday
    });

    const generated = generateDueCycles(db, new Date("2026-01-08T00:00:00.000Z"));
    const byObligation = new Map(generated.map((g) => [g.obligationId, g]));
    expect(byObligation.has("obl_1")).toBe(true);
    expect(byObligation.has("obl_2")).toBe(true);
  });
});
