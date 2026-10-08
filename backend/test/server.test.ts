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

describe("P2P payment request endpoints (QR 'pay me' flow)", () => {
  it("503s on all payment-request routes when not configured", async () => {
    const createRes = await fetch(`${baseUrl}/payment-requests`, { method: "POST" });
    expect(createRes.status).toBe(503);
    const getRes = await fetch(`${baseUrl}/payment-requests/some-id`);
    expect(getRes.status).toBe(503);
    const payRes = await fetch(`${baseUrl}/payment-requests/some-id/pay`, { method: "POST" });
    expect(payRes.status).toBe(503);
  });

  describe("with payment requests configured", () => {
    let prServer: Server;
    let prBaseUrl: string;
    let prDb: Database.Database;
    let policyIds: string[];

    beforeAll(async () => {
      prDb = openDb(":memory:");
      insertUser(prDb, "user_pr_requester");
      setUserWallet(prDb, "user_pr_requester", "wallet_pr_requester", "0x0000000000000000000000000000000000000ee2");
      insertUser(prDb, "user_pr_payer");
      setUserWallet(prDb, "user_pr_payer", "wallet_pr_payer", "0x0000000000000000000000000000000000000ee3");
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
            sendTransaction: async () => ({ hash: "0xfeedface" }),
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

      const sharedDeps = {
        privy: fakePrivy,
        ausdAddress: "0x000000000000000000000000000000000000ff" as const,
        ausdDecimals: 6,
        quoteSigningPrivateKey: `0x${"cd".repeat(32)}` as `0x${string}`,
        agentQuorumId: "agent_quorum_test",
        publicClient: fakePublicClient,
        market: { getFxRate: () => 1500, getFees: () => ({ agentAusd: 0.5, networkAusd: 0.25 }) },
      };

      prServer = createTaxisServer({
        db: prDb,
        checkout: { ...sharedDeps, chainId: 10143, agentPrivateKeyB64: "unused-in-this-fake", expirySeconds: 600 },
        paymentRequests: { ...sharedDeps, quoteExpirySeconds: 600, requestExpirySeconds: 86400 },
      });
      await new Promise<void>((resolve) => prServer.listen(0, resolve));
      const address = prServer.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");
      prBaseUrl = `http://localhost:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => prServer.close((err) => (err ? reject(err) : resolve())));
    });

    it("creates a request, pays it as a different user, and executing settles it — marking the request FULFILLED", async () => {
      const createRes = await fetch(`${prBaseUrl}/payment-requests`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_requester", localAmount: 15_000, localCurrency: "NGN", memo: "Lunch" }),
      });
      expect(createRes.status).toBe(200);
      const createBody = (await createRes.json()) as { request: { id: string; status: string; requesterAddress: string } };
      expect(createBody.request.status).toBe("PENDING");
      expect(createBody.request.requesterAddress).toBe("0x0000000000000000000000000000000000000ee2");
      const requestId = createBody.request.id;

      // Fetching it (what scanning the QR / opening the link does) never
      // moves money — just shows what's being asked for.
      const getRes = await fetch(`${prBaseUrl}/payment-requests/${requestId}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { request: { status: string } };
      expect(getBody.request.status).toBe("PENDING");

      const payRes = await fetch(`${prBaseUrl}/payment-requests/${requestId}/pay`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_payer" }),
      });
      expect(payRes.status).toBe(200);
      const payBody = (await payRes.json()) as { outcome: string; checkout: { id: string }; policyId: string };
      expect(payBody.outcome).toBe("QUOTED");

      // Still PENDING — creating the checkout isn't proof it was ever
      // actually approved/executed, same reasoning as every other
      // confirm-before-retarget flow in this codebase.
      const stillPendingRes = await fetch(`${prBaseUrl}/payment-requests/${requestId}`);
      const stillPendingBody = (await stillPendingRes.json()) as { request: { status: string } };
      expect(stillPendingBody.request.status).toBe("PENDING");

      const execRes = await fetch(`${prBaseUrl}/checkout/${payBody.checkout.id}/execute`, { method: "POST" });
      expect(execRes.status).toBe(200);
      const execBody = (await execRes.json()) as { outcome: string };
      expect(execBody.outcome).toBe("SETTLED");

      const fulfilledRes = await fetch(`${prBaseUrl}/payment-requests/${requestId}`);
      const fulfilledBody = (await fulfilledRes.json()) as { request: { status: string; fulfilledCheckoutId: string } };
      expect(fulfilledBody.request.status).toBe("FULFILLED");
      expect(fulfilledBody.request.fulfilledCheckoutId).toBe(payBody.checkout.id);
    });

    it("rejects paying your own request", async () => {
      const createRes = await fetch(`${prBaseUrl}/payment-requests`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_requester", localAmount: 5_000, localCurrency: "NGN" }),
      });
      const { request } = (await createRes.json()) as { request: { id: string } };

      const payRes = await fetch(`${prBaseUrl}/payment-requests/${request.id}/pay`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_requester" }),
      });
      expect(payRes.status).toBe(400);
    });

    it("rejects paying an already-cancelled request", async () => {
      const createRes = await fetch(`${prBaseUrl}/payment-requests`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_requester", localAmount: 5_000, localCurrency: "NGN" }),
      });
      const { request } = (await createRes.json()) as { request: { id: string } };

      const wrongCancelRes = await fetch(`${prBaseUrl}/payment-requests/${request.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_payer" }),
      });
      expect(wrongCancelRes.status).toBe(403);

      const cancelRes = await fetch(`${prBaseUrl}/payment-requests/${request.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_requester" }),
      });
      expect(cancelRes.status).toBe(200);

      const payRes = await fetch(`${prBaseUrl}/payment-requests/${request.id}/pay`, {
        method: "POST",
        body: JSON.stringify({ userId: "user_pr_payer" }),
      });
      expect(payRes.status).toBe(400);
    });

    it("404s for an unknown request id", async () => {
      const res = await fetch(`${prBaseUrl}/payment-requests/does-not-exist`);
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
      const statusBody = (await statusRes.json()) as {
        configured: boolean;
        backupRecipientId?: string;
        inactivityThresholdDays?: number;
        policyId?: string;
        continuityQuorumId?: string;
      };
      expect(statusBody.configured).toBe(true);
      expect(statusBody.backupRecipientId).toBe("rcp_backup");
      expect(statusBody.inactivityThresholdDays).toBe(60);
      // Real bug, found live: addSigners() is additive-only (rejects
      // re-adding an already-attached signerId as "duplicate"), and
      // removeSigners() strips every signer at once — so re-attaching the
      // AGENT signer elsewhere (New Payment, Renew, Cancel) must rebuild
      // the FULL signer set in one call, or continuity's own authority
      // gets silently dropped. These two fields are what the frontend
      // needs to preserve it.
      expect(statusBody.policyId).toBe(setupBody.policyId);
      expect(statusBody.continuityQuorumId).toBe("continuity_quorum_test");
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

describe("a route handler throwing fails only that request, not the whole server", () => {
  let crashProneServer: Server;
  let crashProneBaseUrl: string;
  let crashProneDb: Database.Database;

  beforeAll(async () => {
    crashProneDb = openDb(":memory:");

    // Reproduces exactly what happened live: findWalletForPrivyUser()
    // (called from /users/sync) threw because Privy's API was unreachable
    // (a real network timeout, not a code bug) — and with no try/catch
    // anywhere in the request-handling chain, that became an unhandled
    // promise rejection that crashed the entire Node process, not just
    // that one request. This fake reproduces the same throw without
    // needing a real network failure.
    const flakyPrivy = {
      wallets: () => ({
        list: async () => {
          throw new Error("simulated network failure reaching Privy");
        },
      }),
    } as any;

    crashProneServer = createTaxisServer({
      db: crashProneDb,
      privy: flakyPrivy,
      ausdAddress: "0x000000000000000000000000000000000000ff",
      ausdDecimals: 6,
      agentQuorumId: "agent_quorum_crash_test",
    });
    await new Promise<void>((resolve) => crashProneServer.listen(0, resolve));
    const address = crashProneServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound port");
    crashProneBaseUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => crashProneServer.close((err) => (err ? reject(err) : resolve())));
  });

  it("returns 500 for the failing request and stays up to serve the next one", async () => {
    const failing = await fetch(`${crashProneBaseUrl}/users/sync`, {
      method: "POST",
      body: JSON.stringify({ userId: "user_flaky" }),
    });
    expect(failing.status).toBe(500);
    const body = (await failing.json()) as { error: string; detail: string };
    expect(body.error).toBe("internal error");
    expect(body.detail).toContain("simulated network failure reaching Privy");

    // The real proof: the server process is still alive and responsive —
    // before this fix, the test runner itself would have crashed on the
    // request above via an unhandled rejection, never reaching this line.
    const healthy = await fetch(`${crashProneBaseUrl}/users/sync`, {
      method: "POST",
      body: JSON.stringify({ userId: "" }), // deliberately invalid, but a normal 400, not a crash
    });
    expect(healthy.status).toBe(400);
  });
});

describe("per-obligation cancel — excludes only this obligation, confirms before touching others", () => {
  let liveServer: Server;
  let liveBaseUrl: string;
  let liveDb: Database.Database;
  let policyIds: string[];

  beforeAll(async () => {
    liveDb = openDb(":memory:");
    insertUser(liveDb, "user_cancel");
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

    const recipientA: Recipient = { id: "rcp_cancel_a", userId: "user_cancel", label: "A", payoutAddress: "0x0000000000000000000000000000000000001a", localCurrency: "NGN", status: "ACTIVE", addedAt: "2026-01-01T00:00:00.000Z" };
    const recipientB: Recipient = { id: "rcp_cancel_b", userId: "user_cancel", label: "B", payoutAddress: "0x0000000000000000000000000000000000002b", localCurrency: "NGN", status: "ACTIVE", addedAt: "2026-01-01T00:00:00.000Z" };
    insertRecipient(liveDb, recipientA);
    insertRecipient(liveDb, recipientB);
    const obligationA: ObligationEnvelope = { id: "obl_cancel_a", userId: "user_cancel", recipientId: "rcp_cancel_a", targetLocalAmount: 300_000, localCurrency: "NGN", maxAusdCost: 210, maxFeeAusd: 3, cumulativeCapAusd: 1000, cadence: { kind: "MONTHLY", dayOfMonth: 1 }, quoteExpirySeconds: 300, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" };
    const obligationB: ObligationEnvelope = { id: "obl_cancel_b", userId: "user_cancel", recipientId: "rcp_cancel_b", targetLocalAmount: 300_000, localCurrency: "NGN", maxAusdCost: 210, maxFeeAusd: 3, cumulativeCapAusd: 1000, cadence: { kind: "MONTHLY", dayOfMonth: 1 }, quoteExpirySeconds: 300, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" };
    insertObligation(liveDb, obligationA);
    insertObligation(liveDb, obligationB);
    recordGrant(liveDb, { obligationId: "obl_cancel_a", kind: "CYCLE", policyId: "policy_original_combined", agentQuorumId: "agent_quorum_live", expiresAt: "2030-01-01T00:00:00.000Z" });
    recordGrant(liveDb, { obligationId: "obl_cancel_b", kind: "CYCLE", policyId: "policy_original_combined", agentQuorumId: "agent_quorum_live", expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => liveServer.close((err) => (err ? reject(err) : resolve())));
  });

  it("builds a policy excluding the cancelled obligation, but changes nothing until confirmed", async () => {
    const cancelRes = await fetch(`${liveBaseUrl}/obligations/obl_cancel_a/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    const { policyId } = (await cancelRes.json()) as { policyId: string };
    expect(policyId).not.toBe("policy_original_combined");

    // Never confirmed yet — both obligations' bookkeeping must be untouched.
    expect(getObligation(liveDb, "obl_cancel_a")?.status).toBe("ACTIVE");
    expect(getActiveGrant(liveDb, "obl_cancel_a", "CYCLE")?.policyId).toBe("policy_original_combined");
    expect(getActiveGrant(liveDb, "obl_cancel_b", "CYCLE")?.policyId).toBe("policy_original_combined");

    const confirmRes = await fetch(`${liveBaseUrl}/obligations/obl_cancel_a/cancel/confirm`, {
      method: "POST",
      body: JSON.stringify({ policyId }),
    });
    expect(confirmRes.status).toBe(200);

    // A is cancelled and its own grant is revoked, not left dangling ACTIVE.
    expect(getObligation(liveDb, "obl_cancel_a")?.status).toBe("CANCELLED");
    expect(getActiveGrant(liveDb, "obl_cancel_a", "CYCLE")).toBeUndefined();

    // B was never cancelled — it keeps its authority, just retargeted onto
    // the new (smaller) combined policy now that the real attach is proven.
    expect(getActiveGrant(liveDb, "obl_cancel_b", "CYCLE")?.policyId).toBe(policyId);
  });
});
