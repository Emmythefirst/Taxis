import type { Checkout, CycleState, CheckoutStatus } from "../types";
import type { CycleWithObligation } from "./AppDataContext";
import { formatUsd } from "./format";

export type ActivityKind = "cycle" | "checkout";

export interface ActivityStatus {
  label: string;
  kind: "success" | "warn" | "neutral";
}

export interface ActivityItem {
  id: string; // cycleId or checkoutId
  kind: ActivityKind;
  obligationId?: string; // present for cycles only
  at: string;
  title: string;
  amount: string;
  status: ActivityStatus;
}

export function cycleStatusPresentation(state: CycleState): ActivityStatus {
  switch (state) {
    case "SETTLED":
      return { label: "Settled", kind: "success" };
    case "REQUIRES_APPROVAL":
      return { label: "Needs review", kind: "warn" };
    case "SKIPPED":
      return { label: "Skipped", kind: "neutral" };
    case "FAILED":
      return { label: "Failed", kind: "warn" };
    case "EXPIRED":
      return { label: "Expired", kind: "neutral" };
    case "EXECUTING":
      return { label: "Executing", kind: "neutral" };
    default:
      return { label: "Pending", kind: "neutral" };
  }
}

export function checkoutStatusPresentation(status: CheckoutStatus): ActivityStatus {
  switch (status) {
    case "SETTLED":
      return { label: "Settled", kind: "success" };
    case "FAILED":
      return { label: "Failed", kind: "warn" };
    case "EXPIRED":
      return { label: "Expired", kind: "neutral" };
    default:
      return { label: "Pending", kind: "neutral" };
  }
}

const TERMINAL_CYCLE_STATES: ReadonlySet<CycleState> = new Set(["SETTLED", "FAILED", "SKIPPED", "EXPIRED"]);

/** Terminal (resolved) cycles + checkouts, merged into one feed sorted newest first. */
export function buildActivityFeed(
  cyclesWithObligation: CycleWithObligation[],
  checkouts: Checkout[],
  recipientLabelForObligation: (obligationId: string) => string,
): ActivityItem[] {
  const cycleItems: ActivityItem[] = cyclesWithObligation
    .filter(({ cycle }) => TERMINAL_CYCLE_STATES.has(cycle.state))
    .map(({ obligationId, cycle }) => ({
      id: cycle.id,
      kind: "cycle",
      obligationId,
      at: cycle.history[cycle.history.length - 1]?.at ?? cycle.dueAt,
      title: `${recipientLabelForObligation(obligationId)}${cycle.quote ? ` · ${formatUsd(cycle.quote.ausdAmount)}` : ""}`,
      amount: cycle.quote ? formatUsd(cycle.quote.ausdAmount) : "—",
      status: cycleStatusPresentation(cycle.state),
    }));

  const checkoutItems: ActivityItem[] = checkouts.map((c) => ({
    id: c.id,
    kind: "checkout",
    at: c.updatedAt,
    title: `Checkout · ${formatUsd(c.quote.ausdAmount)}`,
    amount: formatUsd(c.quote.ausdAmount),
    status: checkoutStatusPresentation(c.status),
  }));

  return [...cycleItems, ...checkoutItems].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
