import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { formatCadence, formatLocalAmount } from "../../app/format";
import { pillColors } from "../../theme/theme";

export function PaymentsList() {
  const { theme, dark } = useAppTheme();
  const { recipients, obligations, cycles } = useAppData();
  const navigate = useNavigate();

  const recipientById = useMemo(() => new Map(recipients.map((r) => [r.id, r])), [recipients]);

  const rows = useMemo(
    () =>
      obligations.map((o) => {
        const recipient = recipientById.get(o.recipientId);
        const hasPendingReview = cycles.some(({ obligationId, cycle }) => obligationId === o.id && cycle.state === "REQUIRES_APPROVAL");
        const status = o.status !== "ACTIVE" ? "Paused" : hasPendingReview ? "Needs review" : "Active";
        const kind: "success" | "warn" | "neutral" = status === "Active" ? "success" : status === "Needs review" ? "warn" : "neutral";

        // Most relevant cycle to jump to: the latest non-settled one if any, else the most recent overall.
        const obligationCycles = cycles.filter((c) => c.obligationId === o.id).map((c) => c.cycle);
        const relevant =
          obligationCycles.find((c) => c.state === "REQUIRES_APPROVAL") ??
          [...obligationCycles].sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime())[0];

        return { obligation: o, recipient, status, kind, relevantCycleId: relevant?.id };
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
          {rows.map(({ obligation: o, recipient, status, kind, relevantCycleId }) => {
            const colors = pillColors(theme, dark, kind);
            return (
              <div
                key={o.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 22px", borderBottom: `1px solid ${theme.border}`, background: theme.surface }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{recipient?.label ?? "Recipient"}</div>
                  <div style={{ fontSize: 13, color: theme.inkMuted, marginTop: 4 }}>
                    {formatCadence(o.cadence)} · {formatLocalAmount(o.targetLocalAmount, o.localCurrency)} · up to ${o.maxAusdCost}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 12, background: colors.bg, color: colors.color }}>{status}</span>
                  <button
                    disabled={!relevantCycleId}
                    onClick={() => relevantCycleId && navigate(`/app/obligations/${o.id}/quotes/${relevantCycleId}`)}
                    style={{
                      padding: "9px 14px",
                      background: "none",
                      border: `1px solid ${theme.border}`,
                      borderRadius: 4,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: relevantCycleId ? "pointer" : "default",
                      color: relevantCycleId ? theme.ink : theme.inkMuted,
                    }}
                  >
                    View quote
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
