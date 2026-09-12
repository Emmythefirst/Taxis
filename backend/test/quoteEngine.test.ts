import { describe, expect, it } from "vitest";
import { createCycle } from "../src/domain/cycleStateMachine.js";
import { CumulativeCapStore } from "../src/domain/reservation.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";
import type { QuoteInputs } from "../src/domain/decisionLoop.js";
import { runCycle, type QuoteEngineDeps, type TransferExecutor } from "../src/engine/quoteEngine.js";
import { deriveQuoteSigningPublicKey, verifyQuoteSignature } from "../src/quoting/signing.js";

const QUOTE_SIGNING_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

function makeEnvelope(overrides: Partial<ObligationEnvelope> = {}): ObligationEnvelope {
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

const INPUTS: QuoteInputs = {
  fxRate: 1500, // 300000 / 1500 = 200 AUSD principal, under 210 ceiling
  feeAgentAusd: 1,
  feeNetworkAusd: 0.5,
  availableBalanceAusd: 500,
  period: "2026-10",
};

type ExecutorBehavior = "succeed" | "reject" | "revert" | "unconfirmed";

class FakeExecutor implements TransferExecutor {
  calls: Array<{ recipientAddress: string; amountBaseUnits: bigint }> = [];
  constructor(private behavior: ExecutorBehavior = "succeed") {}
  async execute(params: { recipientAddress: `0x${string}`; amountBaseUnits: bigint }) {
    this.calls.push(params);
    switch (this.behavior) {
      case "reject":
        throw new Error("400 policy_violation (simulated)");
      case "revert":
        return { hash: "0xdeadbeef", confirmed: true, reverted: true };
      case "unconfirmed":
        return { hash: "0xdeadbeef", confirmed: false, reverted: false };
      case "succeed":
      default:
        return { hash: "0xdeadbeef", confirmed: true, reverted: false };
    }
  }
}

function makeDeps(executor: TransferExecutor): QuoteEngineDeps {
  let i = 0;
  return {
    capStore: new CumulativeCapStore(),
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    makeNonce: () => `nonce_${i++}`,
    quoteSigningPrivateKey: QUOTE_SIGNING_PRIVATE_KEY,
    ausdDecimals: 6,
    executor,
  };
}

describe("runCycle (quote engine)", () => {
  it("settles on-chain when auto-approved, with a real verifiable signature on the quote", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const executor = new FakeExecutor("succeed");
    const deps = makeDeps(executor);

    const result = await runCycle(cycle, makeEnvelope(), makeRecipient(), INPUTS, deps);

    expect(result.outcome).toBe("SETTLED");
    if (result.outcome !== "SETTLED") throw new Error("expected SETTLED");
    expect(result.cycle.state).toBe("SETTLED");
    expect(result.txHash).toBe("0xdeadbeef");

    // The exact amount that hit the chain must match the quote exactly —
    // 200 AUSD principal + 1.5 AUSD fees = 201.5 AUSD = 201_500_000 base
    // units at 6 decimals, converted via string math (see units.test.ts).
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.amountBaseUnits).toBe(201_500_000n);
    expect(executor.calls[0]?.recipientAddress).toBe("0x000000000000000000000000000000000000aa");

    const publicKey = deriveQuoteSigningPublicKey(QUOTE_SIGNING_PRIVATE_KEY);
    expect(verifyQuoteSignature(result.quote, publicKey)).toBe(true);
  });

  it("moves the reservation from reserved to spent only after settlement", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor("succeed"));

    await runCycle(cycle, makeEnvelope(), makeRecipient(), INPUTS, deps);

    const snapshot = deps.capStore.snapshot("obl_1", "2026-10");
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.spent).toBeCloseTo(201.5, 6);
  });

  it("transitions to FAILED and releases the reservation when execution is rejected", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor("reject"));

    const result = await runCycle(cycle, makeEnvelope(), makeRecipient(), INPUTS, deps);

    expect(result.outcome).toBe("FAILED");
    if (result.outcome !== "FAILED") throw new Error("expected FAILED");
    expect(result.cycle.state).toBe("FAILED");
    expect(result.reason).toMatch(/policy_violation/);

    // Released, not settled — this specific cycle can legitimately retry
    // later (reservation.ts: release() clears the cycle_id, settle() would
    // have blocked it permanently).
    const snapshot = deps.capStore.snapshot("obl_1", "2026-10");
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.spent).toBe(0);
  });

  it("transitions to FAILED and releases the reservation when the transaction confirms reverted on-chain", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor("revert"));

    const result = await runCycle(cycle, makeEnvelope(), makeRecipient(), INPUTS, deps);

    expect(result.outcome).toBe("FAILED");
    if (result.outcome !== "FAILED") throw new Error("expected FAILED");
    expect(result.cycle.state).toBe("FAILED");
    expect(result.reason).toMatch(/reverted on-chain/);

    // A confirmed revert means funds definitely did not move — safe to
    // release, same as a rejected send.
    const snapshot = deps.capStore.snapshot("obl_1", "2026-10");
    expect(snapshot.reserved).toBe(0);
    expect(snapshot.spent).toBe(0);
  });

  it("stays in EXECUTING and does NOT release the reservation when confirmation times out", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor("unconfirmed"));

    const result = await runCycle(cycle, makeEnvelope(), makeRecipient(), INPUTS, deps);

    expect(result.outcome).toBe("PENDING_CONFIRMATION");
    if (result.outcome !== "PENDING_CONFIRMATION") throw new Error("expected PENDING_CONFIRMATION");
    // Deliberately NOT terminal — EXECUTING can still legally move to
    // SETTLED or FAILED once the true outcome is later known.
    expect(result.cycle.state).toBe("EXECUTING");
    expect(result.txHash).toBe("0xdeadbeef");

    // Reservation must stay held — releasing it here would let a retry
    // double-pay if the original transaction still lands later.
    const snapshot = deps.capStore.snapshot("obl_1", "2026-10");
    expect(snapshot.reserved).toBeCloseTo(201.5, 6);
    expect(snapshot.spent).toBe(0);
  });

  it("never calls the executor when the decision is REQUIRES_APPROVAL", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const executor = new FakeExecutor("succeed");
    const deps = makeDeps(executor);
    const overTolerance: QuoteInputs = { ...INPUTS, fxRate: 1300 }; // pushes AUSD cost past the ceiling

    const result = await runCycle(cycle, makeEnvelope(), makeRecipient(), overTolerance, deps);

    expect(result.outcome).toBe("REQUIRES_APPROVAL");
    expect(executor.calls).toHaveLength(0);
  });

  it("never calls the executor when the decision is SKIPPED", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const executor = new FakeExecutor("succeed");
    const deps = makeDeps(executor);
    const revokedRecipient = makeRecipient({ status: "REVOKED" });

    const result = await runCycle(cycle, makeEnvelope(), revokedRecipient, INPUTS, deps);

    expect(result.outcome).toBe("SKIPPED");
    expect(executor.calls).toHaveLength(0);
  });

  it("allows a legitimate retry after a FAILED cycle is replaced by a fresh cycle for the same obligation", async () => {
    // Not the same cycle_id retried in place (that's covered by
    // reservation.test.ts) — this proves the engine-level flow still works
    // for a subsequent cycle after a prior one failed.
    const deps = makeDeps(new FakeExecutor("reject"));
    const firstCycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const first = await runCycle(firstCycle, makeEnvelope(), makeRecipient(), INPUTS, deps);
    expect(first.outcome).toBe("FAILED");

    deps.executor = new FakeExecutor("succeed");
    const secondCycle = createCycle("obl_1", "cyc_2", "2026-10-01T09:10:00.000Z");
    const second = await runCycle(secondCycle, makeEnvelope(), makeRecipient(), INPUTS, deps);
    expect(second.outcome).toBe("SETTLED");
  });
});
