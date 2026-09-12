import type { Cycle, CycleState } from "./types.js";

/**
 * Legal transitions per progress.md Section A.3/A.10. Terminal states
 * (SETTLED, EXPIRED, FAILED, SKIPPED) have no outgoing edges — the next
 * cycle is a new Cycle record, never a resurrection of a closed one.
 */
const TRANSITIONS: Record<CycleState, ReadonlySet<CycleState>> = {
  PENDING_QUOTE: new Set(["QUOTED", "SKIPPED"]),
  QUOTED: new Set(["FUNDS_RESERVED", "SKIPPED", "EXPIRED"]),
  FUNDS_RESERVED: new Set(["AUTO_APPROVED", "REQUIRES_APPROVAL", "EXPIRED"]),
  AUTO_APPROVED: new Set(["EXECUTING", "EXPIRED"]),
  REQUIRES_APPROVAL: new Set(["AUTO_APPROVED", "SKIPPED", "EXPIRED"]),
  EXECUTING: new Set(["SETTLED", "FAILED"]),
  SETTLED: new Set(),
  EXPIRED: new Set(),
  FAILED: new Set(),
  SKIPPED: new Set(),
};

export class IllegalTransitionError extends Error {
  constructor(from: CycleState, to: CycleState) {
    super(`Illegal cycle transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CycleState, to: CycleState): boolean {
  return TRANSITIONS[from].has(to);
}

export function isTerminal(state: CycleState): boolean {
  return TRANSITIONS[state].size === 0;
}

/**
 * Applies a state transition, throwing on any illegal edge. Every
 * SKIPPED/FAILED/EXPIRED transition must carry a reason — a cycle never
 * vanishes silently (progress.md Section A.3).
 */
export function transitionCycle(
  cycle: Cycle,
  to: CycleState,
  opts: { reason?: string; at?: string } = {},
): Cycle {
  const from = cycle.state;
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  if ((to === "SKIPPED" || to === "FAILED" || to === "EXPIRED") && !opts.reason) {
    throw new Error(`Transition to ${to} requires a reason — cycles must never fail silently`);
  }
  const at = opts.at ?? new Date().toISOString();
  return {
    ...cycle,
    state: to,
    reason: opts.reason ?? cycle.reason,
    history: [...cycle.history, { from, to, at, reason: opts.reason }],
  };
}

export function createCycle(obligationId: string, id: string, dueAt: string): Cycle {
  return {
    id,
    obligationId,
    dueAt,
    state: "PENDING_QUOTE",
    history: [{ from: null, to: "PENDING_QUOTE", at: new Date().toISOString() }],
  };
}
