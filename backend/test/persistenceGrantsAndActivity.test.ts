import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/persistence/db.js";
import { insertUser, isUserInactive, touchUserActivity } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { getObligation, insertObligation, setBackupRecipient } from "../src/persistence/obligations.js";
import { getActiveGrant, listGrantsForObligation, recordGrant, revokeGrant } from "../src/persistence/grants.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
});

function seedRecipientAndObligation(id = "obl_1") {
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
  const backup: Recipient = { ...recipient, id: "rcp_backup", label: "Sister", payoutAddress: "0x000000000000000000000000000000000000bb" };
  insertRecipient(db, backup);

  const obligation: ObligationEnvelope = {
    id,
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
  return obligation;
}

describe("grants repository", () => {
  it("records a grant and retrieves it as the active grant of its kind", () => {
    seedRecipientAndObligation();
    const grant = recordGrant(db, {
      obligationId: "obl_1",
      kind: "CYCLE",
      policyId: "policy_1",
      agentQuorumId: "agent_quorum_1",
      expiresAt: "2026-02-01T00:00:00.000Z",
    });

    expect(getActiveGrant(db, "obl_1", "CYCLE")).toEqual(grant);
    expect(getActiveGrant(db, "obl_1", "CONTINUITY")).toBeUndefined();
  });

  it("keeps CYCLE and CONTINUITY grants entirely separate", () => {
    seedRecipientAndObligation();
    recordGrant(db, { obligationId: "obl_1", kind: "CYCLE", policyId: "policy_cycle", agentQuorumId: "agent_1", expiresAt: "2026-02-01T00:00:00.000Z" });
    recordGrant(db, { obligationId: "obl_1", kind: "CONTINUITY", policyId: "policy_continuity", agentQuorumId: "continuity_agent_1", expiresAt: "2027-01-01T00:00:00.000Z" });

    expect(getActiveGrant(db, "obl_1", "CYCLE")?.policyId).toBe("policy_cycle");
    expect(getActiveGrant(db, "obl_1", "CONTINUITY")?.policyId).toBe("policy_continuity");
    expect(listGrantsForObligation(db, "obl_1")).toHaveLength(2);
  });

  it("revoking a grant removes it from getActiveGrant without touching the other kind", () => {
    seedRecipientAndObligation();
    const cycleGrant = recordGrant(db, { obligationId: "obl_1", kind: "CYCLE", policyId: "policy_cycle", agentQuorumId: "agent_1", expiresAt: "2026-02-01T00:00:00.000Z" });
    recordGrant(db, { obligationId: "obl_1", kind: "CONTINUITY", policyId: "policy_continuity", agentQuorumId: "continuity_agent_1", expiresAt: "2027-01-01T00:00:00.000Z" });

    revokeGrant(db, cycleGrant.id);

    expect(getActiveGrant(db, "obl_1", "CYCLE")).toBeUndefined();
    expect(getActiveGrant(db, "obl_1", "CONTINUITY")).toBeDefined();
  });

  it("a renewal (new grant recorded) surfaces as the new active grant even with an old one revoked", () => {
    seedRecipientAndObligation();
    const first = recordGrant(db, { obligationId: "obl_1", kind: "CYCLE", policyId: "policy_1", agentQuorumId: "agent_1", expiresAt: "2026-02-01T00:00:00.000Z" });
    revokeGrant(db, first.id);
    const renewed = recordGrant(db, { obligationId: "obl_1", kind: "CYCLE", policyId: "policy_2", agentQuorumId: "agent_1", expiresAt: "2026-03-01T00:00:00.000Z" });

    expect(getActiveGrant(db, "obl_1", "CYCLE")).toEqual(renewed);
  });
});

describe("backup recipient", () => {
  it("is unset by default and can be set/cleared", () => {
    seedRecipientAndObligation();
    expect(getObligation(db, "obl_1")?.backupRecipientId).toBeUndefined();

    setBackupRecipient(db, "obl_1", "rcp_backup");
    expect(getObligation(db, "obl_1")?.backupRecipientId).toBe("rcp_backup");

    setBackupRecipient(db, "obl_1", null);
    expect(getObligation(db, "obl_1")?.backupRecipientId).toBeUndefined();
  });
});

describe("user activity / dead-man's-switch threshold", () => {
  it("is not inactive immediately after creation", () => {
    const reference = new Date("2026-01-01T00:00:00.000Z");
    touchUserActivity(db, "user_1", reference);
    expect(isUserInactive(db, "user_1", 90, reference)).toBe(false);
  });

  it("becomes inactive once the threshold has elapsed since last activity", () => {
    const reference = new Date("2026-01-01T00:00:00.000Z");
    touchUserActivity(db, "user_1", reference); // controlled reference point, not insertUser()'s real "now"
    expect(isUserInactive(db, "user_1", 90, new Date(reference.getTime() + 89 * 24 * 60 * 60 * 1000))).toBe(false);
    expect(isUserInactive(db, "user_1", 90, new Date(reference.getTime() + 91 * 24 * 60 * 60 * 1000))).toBe(true);
  });

  it("touchUserActivity resets the clock", () => {
    const checkIn = new Date("2026-03-01T00:00:00.000Z");
    touchUserActivity(db, "user_1", checkIn);

    expect(isUserInactive(db, "user_1", 90, new Date(checkIn.getTime() + 89 * 24 * 60 * 60 * 1000))).toBe(false);
    expect(isUserInactive(db, "user_1", 90, new Date(checkIn.getTime() + 91 * 24 * 60 * 60 * 1000))).toBe(true);
  });

  it("throws for an unknown user rather than silently treating them as active or inactive", () => {
    expect(() => isUserInactive(db, "user_missing", 90)).toThrow(/Unknown user/);
  });
});
