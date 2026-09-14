import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { recordGrant, getActiveGrant } from "../src/persistence/grants.js";
import { insertCheckout } from "../src/persistence/checkouts.js";
import { rebuildOperationsPolicy } from "../src/engine/operationsPolicy.js";
import type { CheckoutQuote, ObligationEnvelope, Recipient } from "../src/domain/types.js";

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

function seedObligationWithGrant(id: string, recipientAddress: `0x${string}`): void {
  const recipient: Recipient = {
    id: `rcp_${id}`,
    userId: "user_1",
    label: "R",
    payoutAddress: recipientAddress,
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
  recordGrant(db, {
    obligationId: id,
    kind: "CYCLE",
    policyId: "policy_original",
    agentQuorumId: "agent_1",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
}

describe("rebuildOperationsPolicy", () => {
  it("includes a rule for every active CYCLE grant plus an extra rule for the obligation being created", async () => {
    seedObligationWithGrant("obl_existing", "0x0000000000000000000000000000000000001a");
    const privy = fakePrivy();

    const result = await rebuildOperationsPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1", {
      label: "Obligation obl_new",
      recipientAddress: "0x0000000000000000000000000000000000002b",
      maxAmountBaseUnits: 50_000_000n,
      expiresAtUnix: 9999999999,
    });

    expect(result.ruleCount).toBe(2);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.rules).toHaveLength(2);
  });

  it("does NOT retarget any other grant's policy_id itself — creating a policy is not proof it was ever attached", async () => {
    // A reviewer caught this: retargeting here (before any owner-signed
    // attach is confirmed) would leave every other obligation's bookkeeping
    // pointing at a policy that might never actually get attached, if the
    // user backs out of the tap. Retargeting only ever happens at a real
    // confirmation point — see http/routes/obligations.ts's `/grant`
    // handler and http/routes/checkout.ts's `/execute` handler.
    seedObligationWithGrant("obl_a", "0x0000000000000000000000000000000000001a");
    seedObligationWithGrant("obl_b", "0x0000000000000000000000000000000000002b");
    const privy = fakePrivy();

    const result = await rebuildOperationsPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1");

    expect(getActiveGrant(db, "obl_a", "CYCLE")?.policyId).toBe("policy_original");
    expect(getActiveGrant(db, "obl_b", "CYCLE")?.policyId).toBe("policy_original");
    expect(getActiveGrant(db, "obl_a", "CYCLE")?.policyId).not.toBe(result.policyId);
  });

  it("folds in a rule for every checkout still PENDING_APPROVAL", async () => {
    const quote: CheckoutQuote = {
      checkoutId: "checkout_1",
      merchantAddress: "0x0000000000000000000000000000000000003c",
      localAmount: 100,
      localCurrency: "NGN",
      ausdAmount: "10.50",
      fxRateLockedAt: "2026-01-01T00:00:00.000Z",
      fxRate: 1500,
      feeAgentAusd: "0.5",
      feeNetworkAusd: "0.25",
      nonce: "n1",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    insertCheckout(db, { id: "checkout_1", userId: "user_1", merchantAddress: quote.merchantAddress, quote, policyId: "policy_placeholder" });
    const privy = fakePrivy();

    const result = await rebuildOperationsPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1");

    expect(result.ruleCount).toBe(1);
  });

  it("excludes a CYCLE grant whose recorded expiry has already passed", async () => {
    seedObligationWithGrant("obl_expired", "0x0000000000000000000000000000000000001a");
    db.prepare(`UPDATE grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE obligation_id = 'obl_expired'`).run();
    const privy = fakePrivy();

    const result = await rebuildOperationsPolicy({ db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 }, "user_1");

    expect(result.ruleCount).toBe(0);
  });

  it("renewal: excludingObligationId drops that obligation's own stale rule so only the fresh `extra` one is included", async () => {
    seedObligationWithGrant("obl_other", "0x0000000000000000000000000000000000001a");
    seedObligationWithGrant("obl_renewing", "0x0000000000000000000000000000000000002b");
    const privy = fakePrivy();

    const result = await rebuildOperationsPolicy(
      { db, privy, ausdAddress: AUSD_ADDRESS, ausdDecimals: 6 },
      "user_1",
      { label: "Renewed", recipientAddress: "0x0000000000000000000000000000000000002b", maxAmountBaseUnits: 50_000_000n, expiresAtUnix: 9999999999 },
      "obl_renewing",
    );

    // obl_other's existing rule + the ONE fresh renewed rule — never both an old and new rule for obl_renewing.
    expect(result.ruleCount).toBe(2);
  });
});
