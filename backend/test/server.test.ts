import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { createTaxisServer } from "../src/server.js";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { insertCycle } from "../src/persistence/cycles.js";
import { createCycle } from "../src/domain/cycleStateMachine.js";
import { getObligation } from "../src/persistence/obligations.js";
import { getActiveGrant, recordGrant } from "../src/persistence/grants.js";
import { isUserInactive } from "../src/persistence/users.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

const TEST_SECRET = "test-secret-value";
let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  process.env.CRE_TRIGGER_SECRET = TEST_SECRET;
  db = openDb(":memory:"); // isolated in-memory DB, never touches the real data/ file
  server = createTaxisServer({ db });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("Taxis CRE trigger endpoint", () => {
  it("rejects requests missing the shared secret", async () => {
    const res = await fetch(`${baseUrl}/cre/trigger-check`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong shared secret", async () => {
    const res = await fetch(`${baseUrl}/cre/trigger-check`, {
      method: "POST",
      headers: { "x-cre-secret": "wrong-value" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with the correct shared secret and reports zero due cycles when none exist", async () => {
    const res = await fetch(`${baseUrl}/cre/trigger-check`, {
      method: "POST",
      headers: { "x-cre-secret": TEST_SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; dueCycles: number; receivedAt: string };
    expect(body.received).toBe(true);
    expect(body.dueCycles).toBe(0);
    expect(typeof body.receivedAt).toBe("string");
  });

  it("reports a real due cycle once one is persisted", async () => {
    const recipient: Recipient = {
      id: "rcp_1",
      userId: "user_1",
      label: "Mom",
      payoutAddress: "0x000000000000000000000000000000000000aa",
      localCurrency: "NGN",
      status: "ACTIVE",
      addedAt: "2026-09-01T00:00:00.000Z",
    };
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
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    insertUser(db, "user_1");
    insertRecipient(db, recipient);
    insertObligation(db, obligation);
    insertCycle(db, createCycle("obl_1", "cyc_1", "2020-01-01T00:00:00.000Z")); // long past due

    const res = await fetch(`${baseUrl}/cre/trigger-check`, {
      method: "POST",
      headers: { "x-cre-secret": TEST_SECRET },
    });
    const body = (await res.json()) as { dueCycles: number; dueCycleIds: string[] };
    expect(body.dueCycles).toBe(1);
    expect(body.dueCycleIds).toEqual(["cyc_1"]);
  });

  it("404s on unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`, { method: "POST", headers: { "x-cre-secret": TEST_SECRET } });
    expect(res.status).toBe(404);
  });
});

describe("kill-switch endpoint", () => {
  const recipient: Recipient = {
    id: "rcp_ks",
    userId: "user_ks",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-09-01T00:00:00.000Z",
  };
  const obligation: ObligationEnvelope = {
    id: "obl_ks",
    userId: "user_ks",
    recipientId: "rcp_ks",
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd: 1000,
    cadence: { kind: "MONTHLY", dayOfMonth: 1 },
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  it("404s for an unknown obligation", async () => {
    const res = await fetch(`${baseUrl}/obligations/does-not-exist/kill-switch`, {
      method: "POST",
      headers: { "x-user-id": "someone" },
    });
    expect(res.status).toBe(404);
  });

  it("403s when x-user-id does not match the obligation's owner", async () => {
    insertUser(db, "user_ks");
    insertRecipient(db, recipient);
    insertObligation(db, obligation);

    const res = await fetch(`${baseUrl}/obligations/obl_ks/kill-switch`, {
      method: "POST",
      headers: { "x-user-id": "someone-else" },
    });
    expect(res.status).toBe(403);
  });

  it("revokes the active CYCLE grant and pauses the obligation", async () => {
    recordGrant(db, {
      obligationId: "obl_ks",
      kind: "CYCLE",
      policyId: "policy_ks",
      agentQuorumId: "agent_ks",
      expiresAt: "2026-10-01T00:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/obligations/obl_ks/kill-switch`, {
      method: "POST",
      headers: { "x-user-id": "user_ks" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; revokedGrantId: string | null };
    expect(body.status).toBe("PAUSED");
    expect(body.revokedGrantId).not.toBeNull();

    expect(getActiveGrant(db, "obl_ks", "CYCLE")).toBeUndefined();

    expect(getObligation(db, "obl_ks")?.status).toBe("PAUSED");
  });

  it("is idempotent — calling it again with no active grant still succeeds", async () => {
    const res = await fetch(`${baseUrl}/obligations/obl_ks/kill-switch`, {
      method: "POST",
      headers: { "x-user-id": "user_ks" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedGrantId: string | null };
    expect(body.revokedGrantId).toBeNull();
  });
});

describe("check-in endpoint", () => {
  it("404s for an unknown user", async () => {
    const res = await fetch(`${baseUrl}/users/does-not-exist/check-in`, {
      method: "POST",
      headers: { "x-user-id": "does-not-exist" },
    });
    expect(res.status).toBe(404);
  });

  it("403s when x-user-id does not match", async () => {
    insertUser(db, "user_checkin");
    const res = await fetch(`${baseUrl}/users/user_checkin/check-in`, {
      method: "POST",
      headers: { "x-user-id": "someone-else" },
    });
    expect(res.status).toBe(403);
  });

  it("touches last_active_at and returns it", async () => {
    const res = await fetch(`${baseUrl}/users/user_checkin/check-in`, {
      method: "POST",
      headers: { "x-user-id": "user_checkin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastActiveAt: string };
    expect(typeof body.lastActiveAt).toBe("string");

    expect(isUserInactive(db, "user_checkin", 90, new Date())).toBe(false);
  });
});

describe("checkout endpoints", () => {
  it("503s on both checkout routes when checkout is not configured", async () => {
    const quoteRes = await fetch(`${baseUrl}/checkout/quote`, { method: "POST", headers: { "x-cre-secret": TEST_SECRET } });
    expect(quoteRes.status).toBe(503);
    const execRes = await fetch(`${baseUrl}/checkout/some-id/execute`, { method: "POST" });
    expect(execRes.status).toBe(503);
  });

  describe("with checkout configured", () => {
    let checkoutServer: Server;
    let checkoutBaseUrl: string;
    let checkoutDb: Database.Database;
    let policyIds: string[];

    beforeAll(async () => {
      checkoutDb = openDb(":memory:");
      insertUser(checkoutDb, "user_co");
      policyIds = [];

      const fakePrivy = {
        policies: () => ({
          create: async () => {
            const id = `policy_${policyIds.length + 1}`;
            policyIds.push(id);
            return { id };
          },
        }),
      } as any;

      checkoutServer = createTaxisServer({
        db: checkoutDb,
        checkout: {
          privy: fakePrivy,
          ausdAddress: "0x000000000000000000000000000000000000ff",
          ausdDecimals: 6,
          quoteSigningPrivateKey: `0x${"ab".repeat(32)}` as `0x${string}`,
          executor: { execute: async () => ({ hash: "0xdeadbeef", confirmed: true, reverted: false }) },
          getAvailableBalanceAusd: async () => 100,
          market: { getFxRate: () => 1500, getFees: () => ({ agentAusd: 0.5, networkAusd: 0.25 }) },
          expirySeconds: 600,
        },
      });
      await new Promise<void>((resolve) => checkoutServer.listen(0, resolve));
      const address = checkoutServer.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");
      checkoutBaseUrl = `http://localhost:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => checkoutServer.close((err) => (err ? reject(err) : resolve())));
    });

    it("quotes and then executes a checkout end to end", async () => {
      const quoteRes = await fetch(`${checkoutBaseUrl}/checkout/quote`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_co", merchantAddress: "0x000000000000000000000000000000000000cc", localAmount: 15_000, localCurrency: "NGN" }),
      });
      expect(quoteRes.status).toBe(200);
      const quoteBody = (await quoteRes.json()) as { outcome: string; checkout: { id: string }; policyId: string };
      expect(quoteBody.outcome).toBe("QUOTED");
      expect(quoteBody.policyId).toBe("policy_1");

      const execRes = await fetch(`${checkoutBaseUrl}/checkout/${quoteBody.checkout.id}/execute`, { method: "POST" });
      expect(execRes.status).toBe(200);
      const execBody = (await execRes.json()) as { outcome: string; txHash: string };
      expect(execBody.outcome).toBe("SETTLED");
      expect(execBody.txHash).toBe("0xdeadbeef");
    });

    it("404s for an unknown user on quote", async () => {
      const res = await fetch(`${checkoutBaseUrl}/checkout/quote`, {
        method: "POST",
        body: JSON.stringify({ userId: "no-such-user", merchantAddress: "0x000000000000000000000000000000000000cc", localAmount: 100, localCurrency: "NGN" }),
      });
      expect(res.status).toBe(404);
    });

    it("404s executing an unknown checkout id", async () => {
      const res = await fetch(`${checkoutBaseUrl}/checkout/does-not-exist/execute`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});
