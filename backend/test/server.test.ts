import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { createTaxisServer } from "../src/server.js";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet } from "../src/persistence/users.js";
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
      setUserWallet(checkoutDb, "user_co", "wallet_co", "0x00000000000000000000000000000000000ee1");
      policyIds = [];

      const fakePrivy = {
        policies: () => ({
          create: async () => {
            const id = `policy_${policyIds.length + 1}`;
            policyIds.push(id);
            return { id };
          },
        }),
        wallets: () => ({
          ethereum: () => ({
            sendTransaction: async () => ({ hash: "0xdeadbeef" }),
          }),
        }),
      } as any;

      const fakePublicClient = {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "balanceOf") return 100_000_000n; // 100 AUSD at 6 decimals
          throw new Error(`fakePublicClient: unexpected functionName ${functionName}`);
        },
        waitForTransactionReceipt: async () => ({ status: "success" }),
      } as any;

      checkoutServer = createTaxisServer({
        db: checkoutDb,
        checkout: {
          privy: fakePrivy,
          ausdAddress: "0x000000000000000000000000000000000000ff",
          ausdDecimals: 6,
          quoteSigningPrivateKey: `0x${"ab".repeat(32)}` as `0x${string}`,
          chainId: 10143,
          agentPrivateKeyB64: "unused-in-this-fake",
          agentQuorumId: "agent_quorum_test",
          publicClient: fakePublicClient,
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
        body: JSON.stringify({ userId: "user_co", merchantAddress: "0x00000000000000000000000000000000000000cc", localAmount: 15_000, localCurrency: "NGN" }),
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
        body: JSON.stringify({ userId: "no-such-user", merchantAddress: "0x00000000000000000000000000000000000000cc", localAmount: 100, localCurrency: "NGN" }),
      });
      expect(res.status).toBe(404);
    });

    it("404s executing an unknown checkout id", async () => {
      const res = await fetch(`${checkoutBaseUrl}/checkout/does-not-exist/execute`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});

describe("continuity endpoints", () => {
  it("503s on setup/grant, but GET status still reports not-configured, when continuity isn't configured", async () => {
    const statusRes = await fetch(`${baseUrl}/users/does-not-matter/continuity`);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ configured: false });

    const setupRes = await fetch(`${baseUrl}/users/does-not-matter/continuity`, { method: "POST" });
    expect(setupRes.status).toBe(503);
  });

  describe("with continuity configured", () => {
    let continuityServer: Server;
    let continuityBaseUrl: string;
    let continuityDb: Database.Database;
    let policyIds: string[];

    const primaryRecipient: Recipient = {
      id: "rcp_primary",
      userId: "user_cont",
      label: "Primary",
      payoutAddress: "0x0000000000000000000000000000000000001a",
      localCurrency: "NGN",
      status: "ACTIVE",
      addedAt: "2026-09-01T00:00:00.000Z",
    };
    const backupRecipient: Recipient = {
      id: "rcp_backup",
      userId: "user_cont",
      label: "Backup",
      payoutAddress: "0x0000000000000000000000000000000000009b",
      localCurrency: "NGN",
      status: "ACTIVE",
      addedAt: "2026-09-01T00:00:00.000Z",
    };
    const obligation: ObligationEnvelope = {
      id: "obl_cont",
      userId: "user_cont",
      recipientId: "rcp_primary",
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

    beforeAll(async () => {
      continuityDb = openDb(":memory:");
      insertUser(continuityDb, "user_cont");
      insertRecipient(continuityDb, primaryRecipient);
      insertRecipient(continuityDb, backupRecipient);
      insertObligation(continuityDb, obligation);
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

      continuityServer = createTaxisServer({
        db: continuityDb,
        continuity: {
          db: continuityDb,
          privy: fakePrivy,
          ausdAddress: "0x000000000000000000000000000000000000ff",
          ausdDecimals: 6,
          continuityQuorumId: "continuity_quorum_test",
          continuityGrantDurationSeconds: 180 * 24 * 60 * 60,
        },
      });
      await new Promise<void>((resolve) => continuityServer.listen(0, resolve));
      const address = continuityServer.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");
      continuityBaseUrl = `http://localhost:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => continuityServer.close((err) => (err ? reject(err) : resolve())));
    });

    it("sets up continuity end to end: build policy, record grant, then reports configured", async () => {
      const setupRes = await fetch(`${continuityBaseUrl}/users/user_cont/continuity`, {
        method: "POST",
        body: JSON.stringify({ backupRecipientId: "rcp_backup", inactivityThresholdDays: 60 }),
      });
      expect(setupRes.status).toBe(200);
      const setupBody = (await setupRes.json()) as { policyId: string; expiresAtUnix: number; continuityQuorumId: string; obligationIds: string[] };
      expect(setupBody.continuityQuorumId).toBe("continuity_quorum_test");
      expect(setupBody.obligationIds).toEqual(["obl_cont"]);

      const grantRes = await fetch(`${continuityBaseUrl}/users/user_cont/continuity/grant`, {
        method: "POST",
        body: JSON.stringify({ policyId: setupBody.policyId, expiresAtUnix: setupBody.expiresAtUnix, inactivityThresholdDays: 60 }),
      });
      expect(grantRes.status).toBe(200);

      const statusRes = await fetch(`${continuityBaseUrl}/users/user_cont/continuity`);
      const statusBody = (await statusRes.json()) as { configured: boolean; backupRecipientId?: string; inactivityThresholdDays?: number };
      expect(statusBody.configured).toBe(true);
      expect(statusBody.backupRecipientId).toBe("rcp_backup");
      expect(statusBody.inactivityThresholdDays).toBe(60);
    });

    it("400s when the chosen backup recipient doesn't belong to the user", async () => {
      const res = await fetch(`${continuityBaseUrl}/users/user_cont/continuity`, {
        method: "POST",
        body: JSON.stringify({ backupRecipientId: "rcp_primary_of_someone_else", inactivityThresholdDays: 60 }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("obligation renewal", () => {
  it("503s when renewal isn't configured (no live Privy deps)", async () => {
    const res = await fetch(`${baseUrl}/obligations/whatever/renew`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("grant confirmation retargets other active grants — never at creation time", () => {
  let liveServer: Server;
  let liveBaseUrl: string;
  let liveDb: Database.Database;
  let policyIds: string[];

  beforeAll(async () => {
    liveDb = openDb(":memory:");
    insertUser(liveDb, "user_multi");
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

    liveServer = createTaxisServer({
      db: liveDb,
      privy: fakePrivy,
      ausdAddress: "0x000000000000000000000000000000000000ff",
      ausdDecimals: 6,
      agentQuorumId: "agent_quorum_live",
      grantGraceSeconds: 3 * 24 * 60 * 60,
    });
    await new Promise<void>((resolve) => liveServer.listen(0, resolve));
    const address = liveServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound port");
    liveBaseUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => liveServer.close((err) => (err ? reject(err) : resolve())));
  });

  it("obligation A's own grant, created but never confirmed, does not retarget obligation B's already-active grant", async () => {
    // Seed obligation B with an already-active grant on some prior policy.
    const recipientB: Recipient = { id: "rcp_b", userId: "user_multi", label: "B", payoutAddress: "0x0000000000000000000000000000000000002b", localCurrency: "NGN", status: "ACTIVE", addedAt: "2026-01-01T00:00:00.000Z" };
    insertRecipient(liveDb, recipientB);
    const obligationB: ObligationEnvelope = { id: "obl_b", userId: "user_multi", recipientId: "rcp_b", targetLocalAmount: 300_000, localCurrency: "NGN", maxAusdCost: 210, maxFeeAusd: 3, cumulativeCapAusd: 1000, cadence: { kind: "MONTHLY", dayOfMonth: 1 }, quoteExpirySeconds: 300, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" };
    insertObligation(liveDb, obligationB);
    recordGrant(liveDb, { obligationId: "obl_b", kind: "CYCLE", policyId: "policy_before_anything", agentQuorumId: "agent_quorum_live", expiresAt: "2030-01-01T00:00:00.000Z" });

    // Create obligation A — this calls rebuildOperationsPolicy() server-side.
    const recipientA: Recipient = { id: "rcp_a", userId: "user_multi", label: "A", payoutAddress: "0x0000000000000000000000000000000000001a", localCurrency: "NGN", status: "ACTIVE", addedAt: "2026-01-01T00:00:00.000Z" };
    insertRecipient(liveDb, recipientA);
    const createRes = await fetch(`${liveBaseUrl}/users/user_multi/obligations`, {
      method: "POST",
      body: JSON.stringify({
        recipientId: "rcp_a", targetLocalAmount: 300_000, localCurrency: "NGN", maxAusdCost: 210, maxFeeAusd: 3,
        cumulativeCapAusd: 1000, cadence: { kind: "MONTHLY", dayOfMonth: 1 }, quoteExpirySeconds: 300,
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { obligation: { id: string }; policyId: string; expiresAtUnix: number };

    // Simulate the user backing out of the passkey prompt: NEVER call
    // POST /obligations/:id/grant to confirm. Obligation B's bookkeeping
    // must still point at its original policy — not the one A's creation
    // just built server-side but never got attached.
    expect(getActiveGrant(liveDb, "obl_b", "CYCLE")?.policyId).toBe("policy_before_anything");

    // Now the user DOES complete A's real tap — confirm it.
    const grantRes = await fetch(`${liveBaseUrl}/obligations/${created.obligation.id}/grant`, {
      method: "POST",
      body: JSON.stringify({ policyId: created.policyId, expiresAtUnix: created.expiresAtUnix, kind: "CYCLE" }),
    });
    expect(grantRes.status).toBe(200);

    // ONLY now should B's bookkeeping catch up to the combined policy.
    expect(getActiveGrant(liveDb, "obl_b", "CYCLE")?.policyId).toBe(created.policyId);
  });
});
