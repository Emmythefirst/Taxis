import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { buildActivityFeed } from "../../app/activityFeed";
import { pillColors } from "../../theme/theme";

export function ActivityList() {
  const { theme, dark } = useAppTheme();
  const { recipients, obligations, cycles, checkouts } = useAppData();
  const navigate = useNavigate();

  const recipientById = useMemo(() => new Map(recipients.map((r) => [r.id, r])), [recipients]);
  const obligationById = useMemo(() => new Map(obligations.map((o) => [o.id, o])), [obligations]);
  const recipientLabelForObligation = (obligationId: string) => recipientById.get(obligationById.get(obligationId)?.recipientId ?? "")?.label ?? "Payment";

  const feed = useMemo(() => buildActivityFeed(cycles, checkouts, recipientLabelForObligation), [cycles, checkouts, recipientById, obligationById]);

  return (
    <div style={{ animation: "fadeUp 0.4s ease both" }}>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 24 }}>Activity</h1>
      {feed.length === 0 ? (
        <div style={{ color: theme.inkMuted, fontSize: 14 }}>No activity yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
          {feed.map((a) => {
            const colors = pillColors(theme, dark, a.status.kind);
            return (
              <button
                key={`${a.kind}:${a.id}`}
                onClick={() => navigate(`/app/activity/${a.kind}/${a.id}`)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "16px 20px",
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.surface,
                  border: "none",
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  color: theme.ink,
                }}
              >
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>{a.title}</div>
                  <div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 3 }}>{new Date(a.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13.5 }}>{a.amount}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 12, background: colors.bg, color: colors.color }}>{a.status.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
