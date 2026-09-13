import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { getCheckout } from "../src/persistence/checkouts.js";
import { createCheckout, executeCheckout, type CreateCheckoutDeps } from "../src/engine/checkoutEngine.js";
import type { TransferExecutor } from "../src/engine/quoteEngine.js";

const QUOTE_SIGNING_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;
const AUSD_ADDRESS = "0x000000000000000000000000000000000000ff" as const;
const MERCHANT = "0x000000000000000000000000000000000000cc" as const;

let db: Database.Database;
let policyIds: string[];

beforeEach(() => {
  db = openDb(":memory:");
  insertUser(db, "user_1");
  policyIds = [];
});

function fakePrivy(): PrivyClient {
  return {
    policies: () => ({
      create: async (_params: unknown) => {
        const id = `policy_${policyIds.length + 1}`;
        policyIds.push(id);
        return { id };
      },
    }),
  } as unknown as PrivyClient;
}

function makeCreateDeps(overrides: Partial<CreateCheckoutDeps> = {}): CreateCheckoutDeps {
  return {
    db,
    privy: fakePrivy(),
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    makeNonce: () => "nonce_0",
    quoteSigningPrivateKey: QUOTE_SIGNING_PRIVATE_KEY,
    ausdAddress: AUSD_ADDRESS,
    ausdDecimals: 6,
    fxRate: 1500,
    feeAgentAusd: 0.5,
    feeNetworkAusd: 0.25,
    availableBalanceAusd: 100,
    expirySeconds: 600,
    ...overrides,
  };
}

class FakeExecutor implements TransferExecutor {
  calls: Array<{ recipientAddress: string; amountBaseUnits: bigint }> = [];
  constructor(private behavior: "succeed" | "reject" | "revert" | "unconfirmed" = "succeed") {}
  async execute(params: { recipientAddress: `0x${string}`; amountBaseUnits: bigint }) {
    this.calls.push(params);
    switch (this.behavior) {
      case "reject":
        throw new Error("400 policy_violation (simulated)");
      case "revert":
        return { hash: "0xdeadbeef", confirmed: true, reverted: true };
      case "unconfirmed":
        return { hash: "0xdeadbeef", confirmed: false, reverted: false };
      default:
        return { hash: "0xdeadbeef", confirmed: true, reverted: false };
    }
  }
}

describe("createCheckout", () => {
  it("creates a policy, signs a quote, and persists a PENDING_APPROVAL checkout", async () => {
    const result = await createCheckout(makeCreateDeps(), {
      userId: "user_1",
      merchantAddress: MERCHANT,
      localAmount: 15_000,
      localCurrency: "NGN",
    });

    expect(result.outcome).toBe("QUOTED");
    if (result.outcome !== "QUOTED") throw new Error("expected QUOTED");
    expect(result.checkout.status).toBe("PENDING_APPROVAL");
    expect(result.checkout.quote.ausdAmount).toBe("10.75");
    expect(result.policyId).toBe(policyIds[0]);

    const persisted = getCheckout(db, result.checkout.id);
    expect(persisted?.status).toBe("PENDING_APPROVAL");
    expect(persisted?.quote.merchantAddress).toBe(MERCHANT);
  });

  it("does not create a Privy policy at all when the balance is insufficient", async () => {
    const result = await createCheckout(makeCreateDeps({ availableBalanceAusd: 1 }), {
      userId: "user_1",
      merchantAddress: MERCHANT,
      localAmount: 15_000,
      localCurrency: "NGN",
    });

    expect(result.outcome).toBe("INSUFFICIENT_BALANCE");
    expect(policyIds).toHaveLength(0);
  });
});

describe("executeCheckout", () => {
  async function seedPendingCheckout(): Promise<string> {
    const result = await createCheckout(makeCreateDeps(), {
      userId: "user_1",
      merchantAddress: MERCHANT,
      localAmount: 15_000,
      localCurrency: "NGN",
    });
    if (result.outcome !== "QUOTED") throw new Error("expected QUOTED");
    return result.checkout.id;
  }

  it("settles on success and persists the tx hash", async () => {
    const checkoutId = await seedPendingCheckout();
    const executor = new FakeExecutor("succeed");

    const outcome = await executeCheckout({ db, ausdDecimals: 6, executor }, checkoutId);

    expect(outcome).toEqual({ outcome: "SETTLED", txHash: "0xdeadbeef" });
    expect(executor.calls[0]?.amountBaseUnits).toBe(10_750_000n);
    expect(getCheckout(db, checkoutId)?.status).toBe("SETTLED");
  });

  it("fails and persists a reason when the send is rejected", async () => {
    const checkoutId = await seedPendingCheckout();
    const outcome = await executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor("reject") }, checkoutId);

    expect(outcome.outcome).toBe("FAILED");
    expect(getCheckout(db, checkoutId)?.status).toBe("FAILED");
  });

  it("fails when the transaction confirms reverted on-chain", async () => {
    const checkoutId = await seedPendingCheckout();
    const outcome = await executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor("revert") }, checkoutId);

    expect(outcome.outcome).toBe("FAILED");
    if (outcome.outcome !== "FAILED") throw new Error("expected FAILED");
    expect(outcome.reason).toMatch(/reverted on-chain/);
  });

  it("returns PENDING_CONFIRMATION without marking the checkout FAILED when unconfirmed", async () => {
    const checkoutId = await seedPendingCheckout();
    const outcome = await executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor("unconfirmed") }, checkoutId);

    expect(outcome).toEqual({ outcome: "PENDING_CONFIRMATION", txHash: "0xdeadbeef" });
    // Deliberately left PENDING_APPROVAL, not FAILED — same reasoning as
    // quoteEngine.ts: an unconfirmed outcome must not be guessed at.
    expect(getCheckout(db, checkoutId)?.status).toBe("PENDING_APPROVAL");
  });

  it("throws for an unknown checkout id", async () => {
    await expect(executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor() }, "checkout_missing")).rejects.toThrow(/Unknown checkout/);
  });

  it("throws if executed twice (not PENDING_APPROVAL the second time)", async () => {
    const checkoutId = await seedPendingCheckout();
    await executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor("succeed") }, checkoutId);

    await expect(executeCheckout({ db, ausdDecimals: 6, executor: new FakeExecutor("succeed") }, checkoutId)).rejects.toThrow(/not PENDING_APPROVAL/);
  });

  it("marks an expired checkout EXPIRED instead of attempting execution", async () => {
    // executeCheckout checks expiry against real Date.now(), so build a
    // checkout whose expiresAt is already in the past via a negative
    // expirySeconds rather than trying to fake the clock.
    const result = await createCheckout(makeCreateDeps({ expirySeconds: -1 }), {
      userId: "user_1",
      merchantAddress: MERCHANT,
      localAmount: 15_000,
      localCurrency: "NGN",
    });
    if (result.outcome !== "QUOTED") throw new Error("expected QUOTED");

    const outcome = await executeCheckout(
      { db, ausdDecimals: 6, executor: new FakeExecutor("succeed"), now: () => new Date("2026-10-01T09:00:00.000Z") },
      result.checkout.id,
    );
    expect(outcome.outcome).toBe("FAILED");
    expect(getCheckout(db, result.checkout.id)?.status).toBe("EXPIRED");
  });
});
