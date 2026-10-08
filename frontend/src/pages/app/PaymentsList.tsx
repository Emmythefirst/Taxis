import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { formatCadence, formatLocalAmount } from "../../app/format";
import { pillColors } from "../../theme/theme";

const NON_TERMINAL = new Set(["PENDING_QUOTE", "QUOTED", "FUNDS_RESERVED", "AUTO_APPROVED", "REQUIRES_APPROVAL", "EXECUTING"]);

export function PaymentsList() {
  const { theme, dark } = useAppTheme();
  const { recipients, obligations, cycles } = useAppData();
  const navigate = useNavigate();

  const recipientById = useMemo(() => new Map(recipients.map((r) => [r.id, r])), [recipients]);

  const rows = useMemo(
    () =>
      obligations.map((o) => {
        const recipient = recipientById.get(o.recipientId);

        // Most relevant cycle to jump to: the latest non-settled one if any, else the most recent overall.
        const obligationCycles = cycles.filter((c) => c.obligationId === o.id).map((c) => c.cycle);
        const pendingReview = obligationCycles.find((c) => c.state === "REQUIRES_APPROVAL");
        const relevant = pendingReview ?? [...obligationCycles].sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime())[0];

        // CANCELLED and PAUSED used to collapse into the same "Paused"
        // label — misleading for CANCELLED specifically, since it implies
        // something resumable, and a cancelled obligation (new this
        // session — Settings' per-obligation "Cancel payment") is a
        // deliberate, permanent removal, not a pause.
        const status = o.status === "CANCELLED" ? "Cancelled" : o.status !== "ACTIVE" ? "Paused" : pendingReview ? "Needs review" : "Active";
        const kind: "success" | "warn" | "neutral" = status === "Active" ? "success" : status === "Needs review" ? "warn" : "neutral";
        const nextDueAt = status === "Active" && relevant && NON_TERMINAL.has(relevant.state) ? relevant.dueAt : undefined;

        return { obligation: o, recipient, status, kind, relevantCycleId: relevant?.id, reviewReason: pendingReview?.reason, nextDueAt };
      }),
    [obligations, recipientById, cycles],
  );

  return (
    <div style={{ animation: "fadeUp 0.4s ease both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em" }}>Payments</h1>
        <button
          onClick={() => navigate("/app/payments/new")}
          style={{ padding: "11px 18px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
        >
          + New payment
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: theme.inkMuted, fontSize: 14 }}>No payments set up yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
          {rows.map(({ obligation: o, recipient, status, kind, relevantCycleId, reviewReason, nextDueAt }) => {
            const colors = pillColors(theme, dark, kind);
            const needsReview = status === "Needs review";
            return (
              <div
                key={o.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "20px 22px",
                  borderBottom: `1px solid ${theme.border}`,
                  // A same-weight pill undersold this — REQUIRES_APPROVAL
                  // is arguably the single most important state in the
                  // whole app (the agent stopped itself, on purpose,
                  // because a real number crossed a real limit). A left
                  // accent + tinted background gives it the visual weight
                  // that actually matches what it means.
                  borderLeft: `3px solid ${needsReview ? theme.warn : "transparent"}`,
                  background: needsReview ? colors.bg : theme.surface,
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{recipient?.label ?? "Recipient"}</div>
                  <div style={{ fontSize: 13, color: theme.inkMuted, marginTop: 4 }}>
                    {formatCadence(o.cadence)} · {formatLocalAmount(o.targetLocalAmount, o.localCurrency)} · up to ${o.maxAusdCost}
                  </div>
                  {nextDueAt && (
                    <div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 4 }}>
                      Next payment {new Date(nextDueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </div>
                  )}
                  {needsReview && reviewReason && (
                    <div style={{ fontSize: 12.5, color: theme.warn, marginTop: 6, maxWidth: 360, lineHeight: 1.4 }}>{reviewReason}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 12, background: colors.bg, color: colors.color }}>{status}</span>
                  <button
                    disabled={!relevantCycleId}
                    onClick={() => relevantCycleId && navigate(`/app/obligations/${o.id}/quotes/${relevantCycleId}`)}
                    style={{
                      padding: "9px 14px",
                      background: needsReview ? theme.warn : "none",
                      border: needsReview ? "none" : `1px solid ${theme.border}`,
                      borderRadius: 4,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: relevantCycleId ? "pointer" : "default",
                      color: needsReview ? "#fff" : relevantCycleId ? theme.ink : theme.inkMuted,
                    }}
                  >
                    {needsReview ? "Review payment" : "View payment"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
