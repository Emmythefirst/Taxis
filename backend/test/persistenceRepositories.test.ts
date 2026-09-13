import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { getRecipient, insertRecipient, listRecipientsForUser, updateRecipientStatus } from "../src/persistence/recipients.js";
import { getObligation, insertObligation, listActiveObligations, updateObligationStatus } from "../src/persistence/obligations.js";
import { getCycle, insertCycle, listCyclesForObligation, listDueCycles, saveCycle } from "../src/persistence/cycles.js";
import { createCycle, transitionCycle } from "../src/domain/cycleStateMachine.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
});

function makeRecipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    id: "rcp_1",
    userId: "user_1",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeObligation(overrides: Partial<ObligationEnvelope> = {}): ObligationEnvelope {
  return {
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
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("recipients repository", () => {
  it("round-trips a recipient exactly", () => {
    const recipient = makeRecipient();
    insertRecipient(db, recipient);
    expect(getRecipient(db, "rcp_1")).toEqual(recipient);
  });

  it("lists recipients for a user, and returns undefined for an unknown id", () => {
    insertRecipient(db, makeRecipient());
    insertRecipient(db, makeRecipient({ id: "rcp_2", label: "Dad" }));

    expect(listRecipientsForUser(db, "user_1")).toHaveLength(2);
    expect(getRecipient(db, "rcp_missing")).toBeUndefined();
  });

  it("updates recipient status (allowlist revocation)", () => {
    insertRecipient(db, makeRecipient());
    updateRecipientStatus(db, "rcp_1", "REVOKED");
    expect(getRecipient(db, "rcp_1")?.status).toBe("REVOKED");
  });
});

describe("obligations repository", () => {
  it("round-trips an obligation including the Cadence union through cadence_json", () => {
    insertRecipient(db, makeRecipient());
    const obligation = makeObligation();
    insertObligation(db, obligation);
    expect(getObligation(db, "obl_1")).toEqual(obligation);
  });

  it("lists only ACTIVE obligations", () => {
    insertRecipient(db, makeRecipient());
    insertObligation(db, makeObligation());
    insertObligation(db, makeObligation({ id: "obl_2", status: "PAUSED" }));

    const active = listActiveObligations(db);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe("obl_1");

    updateObligationStatus(db, "obl_1", "CANCELLED");
    expect(listActiveObligations(db)).toHaveLength(0);
  });
});

describe("cycles repository", () => {
  beforeEach(() => {
    insertRecipient(db, makeRecipient());
    insertObligation(db, makeObligation());
  });

  it("round-trips a freshly-created cycle, including its history", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    insertCycle(db, cycle);

    const fetched = getCycle(db, "cyc_1");
    expect(fetched?.state).toBe("PENDING_QUOTE");
    expect(fetched?.history).toHaveLength(1);
    expect(fetched?.quote).toBeUndefined();
  });

  it("persists state transitions via saveCycle, including a serialized quote", () => {
    let cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    insertCycle(db, cycle);

    cycle = transitionCycle(cycle, "SKIPPED", { reason: "Recipient not on allowlist", at: "2026-10-01T09:00:01.000Z" });
    saveCycle(db, cycle);

    const fetched = getCycle(db, "cyc_1");
    expect(fetched?.state).toBe("SKIPPED");
    expect(fetched?.reason).toBe("Recipient not on allowlist");
    expect(fetched?.history).toHaveLength(2);
  });

  it("lists cycles for an obligation ordered by due date", () => {
    insertCycle(db, createCycle("obl_1", "cyc_2", "2026-10-15T09:00:00.000Z"));
    insertCycle(db, createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z"));

    const cycles = listCyclesForObligation(db, "obl_1");
    expect(cycles.map((c) => c.id)).toEqual(["cyc_1", "cyc_2"]);
  });

  describe("listDueCycles", () => {
    it("returns only PENDING_QUOTE cycles due at or before the given time, for ACTIVE obligations", () => {
      insertCycle(db, createCycle("obl_1", "cyc_due", "2026-10-01T09:00:00.000Z"));
      insertCycle(db, createCycle("obl_1", "cyc_future", "2026-12-01T09:00:00.000Z"));

      let quoted = createCycle("obl_1", "cyc_already_quoted", "2026-10-01T09:00:00.000Z");
      quoted = transitionCycle(quoted, "QUOTED", { at: "2026-10-01T09:00:01.000Z" });
      insertCycle(db, quoted);

      const due = listDueCycles(db, "2026-10-01T09:00:00.000Z");
      expect(due.map((c) => c.id)).toEqual(["cyc_due"]);
    });

    it("excludes due cycles whose obligation is no longer ACTIVE", () => {
      insertCycle(db, createCycle("obl_1", "cyc_due", "2026-10-01T09:00:00.000Z"));
      updateObligationStatus(db, "obl_1", "PAUSED");

      expect(listDueCycles(db, "2026-10-01T09:00:00.000Z")).toHaveLength(0);
    });
  });
});
