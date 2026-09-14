import { describe, expect, it } from "vitest";
import { createCycle } from "../src/domain/cycleStateMachine.js";
import { CumulativeCapStore } from "../src/domain/reservation.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";
import type { QuoteInputs } from "../src/domain/decisionLoop.js";
import { runCycle, approveCycle, skipCycle, type QuoteEngineDeps, type TransferExecutor } from "../src/engine/quoteEngine.js";

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

function makeRecipient(): Recipient {
  return {
    id: "rcp_1",
    userId: "user_1",
    label: "Mom",
    payoutAddress: "0x000000000000000000000000000000000000aa",
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: "2026-09-01T00:00:00.000Z",
  };
}

class FakeExecutor implements TransferExecutor {
  calls: Array<{ recipientAddress: string; amountBaseUnits: bigint }> = [];
  async execute(params: { recipientAddress: `0x${string}`; amountBaseUnits: bigint }) {
    this.calls.push(params);
    return { hash: "0xdeadbeef", confirmed: true, reverted: false };
  }
}

function makeDeps(executor: TransferExecutor, now: () => Date = () => new Date("2026-10-01T09:00:00.000Z")): QuoteEngineDeps {
  let i = 0;
  return {
    capStore: new CumulativeCapStore(),
    now,
    makeNonce: () => `nonce_${i++}`,
    quoteSigningPrivateKey: QUOTE_SIGNING_PRIVATE_KEY,
    ausdDecimals: 6,
    executor,
  };
}

// FX rate pushes the AUSD principal over the 210 ceiling -> REQUIRES_APPROVAL.
const OVER_TOLERANCE_INPUTS: QuoteInputs = {
  fxRate: 1300,
  feeAgentAusd: 1,
  feeNetworkAusd: 0.5,
  availableBalanceAusd: 500,
  period: "2026-10",
};

describe("approveCycle", () => {
  it("executes the exact already-issued quote and settles, reusing the existing reservation", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor());

    const requiresApproval = await runCycle(cycle, makeEnvelope(), makeRecipient(), OVER_TOLERANCE_INPUTS, deps);
    expect(requiresApproval.outcome).toBe("REQUIRES_APPROVAL");
    if (requiresApproval.outcome !== "REQUIRES_APPROVAL") throw new Error("expected REQUIRES_APPROVAL");

    const executor = deps.executor as FakeExecutor;
    const outcome = await approveCycle(requiresApproval.cycle, deps);

    expect(outcome.outcome).toBe("SETTLED");
    expect(executor.calls).toHaveLength(1);
    // The executed amount matches the ORIGINAL quote, not a freshly recomputed one.
    if (outcome.outcome === "SETTLED") {
      expect(outcome.quote.ausdAmount).toBe(requiresApproval.quote.ausdAmount);
    }
  });

  it("expires instead of executing, and releases the reservation, when approved after the quote's expiry", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor());

    const requiresApproval = await runCycle(cycle, makeEnvelope(), makeRecipient(), OVER_TOLERANCE_INPUTS, deps);
    if (requiresApproval.outcome !== "REQUIRES_APPROVAL") throw new Error("expected REQUIRES_APPROVAL");

    const lateDeps = { ...deps, now: () => new Date("2026-10-01T09:10:00.000Z") }; // 10 min later, past the 300s expiry
    const executor = deps.executor as FakeExecutor;
    const outcome = await approveCycle(requiresApproval.cycle, lateDeps);

    expect(outcome.outcome).toBe("EXPIRED");
    expect(executor.calls).toHaveLength(0);
    // Reservation released -> a fresh reservation for the same period should now succeed.
    const snapshot = deps.capStore.snapshot("obl_1", "2026-10");
    expect(snapshot.reserved).toBe(0);
  });

  it("throws for a cycle that isn't REQUIRES_APPROVAL", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z"); // still PENDING_QUOTE
    const deps = makeDeps(new FakeExecutor());
    await expect(approveCycle(cycle, deps)).rejects.toThrow(/not REQUIRES_APPROVAL/);
  });
});

describe("skipCycle", () => {
  it("releases the reservation and marks the cycle SKIPPED", async () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor());

    const requiresApproval = await runCycle(cycle, makeEnvelope(), makeRecipient(), OVER_TOLERANCE_INPUTS, deps);
    if (requiresApproval.outcome !== "REQUIRES_APPROVAL") throw new Error("expected REQUIRES_APPROVAL");

    const skipped = skipCycle(requiresApproval.cycle, deps);

    expect(skipped.state).toBe("SKIPPED");
    expect(skipped.reason).toMatch(/chose to skip/);
    expect(deps.capStore.snapshot("obl_1", "2026-10").reserved).toBe(0);
  });

  it("throws for a cycle that isn't REQUIRES_APPROVAL", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const deps = makeDeps(new FakeExecutor());
    expect(() => skipCycle(cycle, deps)).toThrow(/not REQUIRES_APPROVAL/);
  });
});
