import { describe, expect, it } from "vitest";
import { createCycle } from "../src/domain/cycleStateMachine.js";
import { runDecisionLoop, type QuoteInputs } from "../src/domain/decisionLoop.js";
import { CumulativeCapStore } from "../src/domain/reservation.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

function makeEnvelope(overrides: Partial<ObligationEnvelope> = {}): ObligationEnvelope {
  return {
    id: "obl_1",
    userId: "user_1",
    recipientId: "rcp_1",
    targetLocalAmount: 300_000, // NGN
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

function deps() {
  return {
    capStore: new CumulativeCapStore(),
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    sign: () => "0xsignature",
    makeNonce: (() => {
      let i = 0;
      return () => `nonce_${i++}`;
    })(),
  };
}

describe("runDecisionLoop", () => {
  it("auto-approves when FX and fee are within tolerance and funds are sufficient", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const envelope = makeEnvelope();
    const recipient = makeRecipient();
    const inputs: QuoteInputs = {
      fxRate: 1500, // 300000 / 1500 = 200 AUSD principal, under 210 ceiling
      feeAgentAusd: 1,
      feeNetworkAusd: 0.5,
      availableBalanceAusd: 500,
      period: "2026-10",
    };

    const result = runDecisionLoop(cycle, envelope, recipient, inputs, deps());
    expect(result.outcome).toBe("AUTO_APPROVED");
    expect(result.cycle.state).toBe("AUTO_APPROVED");
    expect(result.cycle.quote?.nonce).toBe("nonce_0");
  });

  it("requires approval when FX drift pushes the AUSD cost past the ceiling", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const envelope = makeEnvelope();
    const recipient = makeRecipient();
    const inputs: QuoteInputs = {
      fxRate: 1300, // 300000 / 1300 ≈ 230.8 AUSD principal, over 210 ceiling
      feeAgentAusd: 1,
      feeNetworkAusd: 0.5,
      availableBalanceAusd: 500,
      period: "2026-10",
    };

    const result = runDecisionLoop(cycle, envelope, recipient, inputs, deps());
    expect(result.outcome).toBe("REQUIRES_APPROVAL");
    expect(result.cycle.reason).toMatch(/exceeds your ceiling/);
    // Still produces a real, signed quote — the user sees exact numbers,
    // not a generic warning (progress.md Section A.11).
    expect(result.cycle.quote?.signature).toBe("0xsignature");
  });

  it("skips (never silently) when the recipient is not on the active allowlist", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const envelope = makeEnvelope();
    const recipient = makeRecipient({ status: "REVOKED" });
    const inputs: QuoteInputs = {
      fxRate: 1500,
      feeAgentAusd: 1,
      feeNetworkAusd: 0.5,
      availableBalanceAusd: 500,
      period: "2026-10",
    };

    const result = runDecisionLoop(cycle, envelope, recipient, inputs, deps());
    expect(result.outcome).toBe("SKIPPED");
    expect(result.cycle.state).toBe("SKIPPED");
    expect(result.cycle.reason).toMatch(/allowlist/);
  });

  it("skips on check-then-quote: never issues a quote the wallet can't cover", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const envelope = makeEnvelope();
    const recipient = makeRecipient();
    const inputs: QuoteInputs = {
      fxRate: 1500,
      feeAgentAusd: 1,
      feeNetworkAusd: 0.5,
      availableBalanceAusd: 50, // not enough to cover ~201.5 AUSD
      period: "2026-10",
    };

    const result = runDecisionLoop(cycle, envelope, recipient, inputs, deps());
    expect(result.outcome).toBe("SKIPPED");
    expect(result.cycle.quote).toBeUndefined();
    expect(result.cycle.reason).toMatch(/Insufficient balance/);
  });

  it("skips when the cumulative cap reservation fails for the period", () => {
    const cycle1 = createCycle("obl_1", "cyc_1", "2026-10-01T09:00:00.000Z");
    const cycle2 = createCycle("obl_1", "cyc_2", "2026-10-15T09:00:00.000Z");
    const envelope = makeEnvelope({ cumulativeCapAusd: 205 }); // one cycle's worth
    const recipient = makeRecipient();
    const sharedDeps = deps();
    const inputs: QuoteInputs = {
      fxRate: 1500,
      feeAgentAusd: 1,
      feeNetworkAusd: 0.5,
      availableBalanceAusd: 500,
      period: "2026-10",
    };

    const first = runDecisionLoop(cycle1, envelope, recipient, inputs, sharedDeps);
    expect(first.outcome).toBe("AUTO_APPROVED");

    // A second cycle in the same period, same obligation, should exhaust
    // the period cap and be skipped rather than silently double-spending.
    const second = runDecisionLoop(cycle2, envelope, recipient, inputs, sharedDeps);
    expect(second.outcome).toBe("SKIPPED");
    expect(second.cycle.reason).toMatch(/Cumulative spending cap/);
  });
});
