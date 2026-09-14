import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation, setBackupRecipient } from "../src/persistence/obligations.js";
import { rebuildContinuityPolicy } from "../src/engine/continuityPolicy.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

const AUSD_ADDRESS = "0x000000000000000000000000000000000000ff" as const;

let db: Database.Database;
let createCalls: Array<{ rules: unknown[] }>;

beforeEach(() => {
  db = openDb(":memory:");
  createCalls = [];
  insertUser(db, "user_1");
});

function fakePrivy(): PrivyClient {
  return {
    policies: () => ({
      create: async (params: { rules: unknown[] }) => {
        createCalls.push({ rules: params.rules });
        return { id: `policy_${createCalls.length}` };
      },
    }),
  } as unknown as PrivyClient;
}

function seedObligation(id: string, backupRecipientId?: string): void {
  const recipient: Recipient = {
    id: `rcp_${id}`,
    userId: "user_1",
    label: "Primary",
    payoutAddress: "0x0000000000000000000000000000000000001a",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  insertRecipient(db, recipient);
  const obligation: ObligationEnvelope = {
    id,
    userId: "user_1",
    recipientId: recipient.id,
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 200,
    maxFeeAusd: 1,
    cumulativeCapAusd: 1000,
    cadence: { kind: "MONTHLY", dayOfMonth: 1 },
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  insertObligation(db, obligation);
  if (backupRecipientId) setBackupRecipient(db, id, backupRecipientId);
}

describe("rebuildContinuityPolicy", () => {
  it("builds one rule per ACTIVE obligation that has a backup recipient configured", async () => {
    const backup: Recipient = {
      id: "rcp_backup",
      userId: "user_1",
      label: "Backup",
      payoutAddress: "0x0000000000000000000000000000000000009b",
      localCurrency: "NGN",
      status: "ACTIVE",
      addedAt: "2026-01-01T00:00:00.000Z",
    };
    insertRecipient(db, backup);
    seedObligation("obl_a", "rcp_backup");
    seedObligation("obl_b", "rcp_backup");
    seedObligation("obl_c"); // no backup configured — excluded
    const privy = fakePrivy();

    const result = await rebuildContinuityPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1", 9999999999);

    expect(result.obligationIds.sort()).toEqual(["obl_a", "obl_b"]);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.rules).toHaveLength(2);
  });

  it("returns zero rules when no obligation has a backup recipient configured yet", async () => {
    seedObligation("obl_a");
    const privy = fakePrivy();

    const result = await rebuildContinuityPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1", 9999999999);

    expect(result.obligationIds).toHaveLength(0);
    expect(createCalls[0]!.rules).toHaveLength(0);
  });
});
