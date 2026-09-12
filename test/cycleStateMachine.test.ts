import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  canTransition,
  createCycle,
  isTerminal,
  transitionCycle,
} from "../src/domain/cycleStateMachine.js";

describe("cycle state machine", () => {
  it("starts every cycle in PENDING_QUOTE with a history entry", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    expect(cycle.state).toBe("PENDING_QUOTE");
    expect(cycle.history).toHaveLength(1);
    expect(cycle.history[0]).toMatchObject({ from: null, to: "PENDING_QUOTE" });
  });

  it("allows the happy path: PENDING_QUOTE -> ... -> SETTLED", () => {
    let cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    cycle = transitionCycle(cycle, "QUOTED");
    cycle = transitionCycle(cycle, "FUNDS_RESERVED");
    cycle = transitionCycle(cycle, "AUTO_APPROVED");
    cycle = transitionCycle(cycle, "EXECUTING");
    cycle = transitionCycle(cycle, "SETTLED");
    expect(cycle.state).toBe("SETTLED");
    expect(cycle.history.map((h) => h.to)).toEqual([
      "PENDING_QUOTE",
      "QUOTED",
      "FUNDS_RESERVED",
      "AUTO_APPROVED",
      "EXECUTING",
      "SETTLED",
    ]);
  });

  it("routes an out-of-tolerance quote through REQUIRES_APPROVAL back to AUTO_APPROVED", () => {
    let cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    cycle = transitionCycle(cycle, "QUOTED");
    cycle = transitionCycle(cycle, "FUNDS_RESERVED");
    cycle = transitionCycle(cycle, "REQUIRES_APPROVAL", { reason: "FX drift exceeded tolerance" });
    cycle = transitionCycle(cycle, "AUTO_APPROVED");
    expect(cycle.state).toBe("AUTO_APPROVED");
  });

  it("rejects illegal transitions, e.g. skipping straight to SETTLED", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    expect(() => transitionCycle(cycle, "SETTLED")).toThrow(IllegalTransitionError);
  });

  it("never allows a transition out of a terminal state", () => {
    let cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    cycle = transitionCycle(cycle, "SKIPPED", { reason: "insufficient balance" });
    expect(isTerminal(cycle.state)).toBe(true);
    expect(canTransition("SKIPPED", "QUOTED")).toBe(false);
    expect(() => transitionCycle(cycle, "QUOTED")).toThrow(IllegalTransitionError);
  });

  it("requires a reason for SKIPPED, FAILED, and EXPIRED — never a silent failure", () => {
    const cycle = createCycle("obl_1", "cyc_1", "2026-10-01T00:00:00.000Z");
    expect(() => transitionCycle(cycle, "SKIPPED")).toThrow(/requires a reason/);
  });
});
