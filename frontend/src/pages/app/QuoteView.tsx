import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { useCountdown } from "../../app/useCountdown";
import { formatLocalAmount, formatUsd } from "../../app/format";
import * as endpoints from "../../api/endpoints";

export function QuoteView() {
  const { obligationId, cycleId } = useParams<{ obligationId: string; cycleId: string }>();
  const { theme } = useAppTheme();
  const { obligations, recipients, cycles, refresh } = useAppData();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const obligation = obligations.find((o) => o.id === obligationId);
  const recipient = recipients.find((r) => r.id === obligation?.recipientId);
  const cycle = cycles.find((c) => c.cycle.id === cycleId)?.cycle;
  const quote = cycle?.quote;
  const expiryLabel = useCountdown(quote?.expiresAt);

  const feeTotal = useMemo(() => (quote ? Number(quote.feeAgentAusd) + Number(quote.feeNetworkAusd) : 0), [quote]);

  async function handleApprove() {
    if (!obligationId || !cycleId) return;
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.approveCycle(obligationId, cycleId);
      await refresh();
      navigate("/app/payments");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!obligationId || !cycleId) return;
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.skipCycle(obligationId, cycleId);
      await refresh();
      navigate("/app/payments");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!obligation || !cycle) {
    return (
      <div style={{ maxWidth: 480 }}>
        <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
          ← Back
        </button>
        <p style={{ color: theme.inkMuted, fontSize: 14 }}>Quote not found.</p>
      </div>
    );
  }

  const isRequiresApproval = cycle.state === "REQUIRES_APPROVAL";
  const heading = isRequiresApproval ? "Requires approval" : cycle.state === "SETTLED" ? "Settled" : "Payment quote";

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 480 }}>
      <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
        ← Back
      </button>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{heading}</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: theme.inkMuted }}>{quote ? `REF-${quote.nonce}` : cycle.id}</span>
        </div>

        {!quote ? (
          <p style={{ color: theme.inkMuted, fontSize: 14 }}>No quote generated yet for this cycle — check back once it's due.</p>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <Row theme={theme} label="To" value={recipient?.label ?? "Recipient"} />
              <Row theme={theme} label="They get" value={formatLocalAmount(quote.localAmount, quote.localCurrency)} mono />
              <Row theme={theme} label="You send" value={formatUsd(quote.ausdAmount)} mono color={isRequiresApproval ? theme.warn : undefined} />
              <Row theme={theme} label="Rate locked" value={`1 AUSD = ${quote.fxRate.toLocaleString()} ${quote.localCurrency}`} mono />
              <Row theme={theme} label="Fee" value={formatUsd(feeTotal)} mono />
              {!["SETTLED", "FAILED", "SKIPPED", "EXPIRED"].includes(cycle.state) && (
                <Row theme={theme} label="Expires in" value={expiryLabel} mono color={theme.warn} />
              )}
            </div>

            {!isRequiresApproval ? (
              <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${theme.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", background: theme.success, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>
                  ✓
                </div>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {cycle.state === "SETTLED" ? "Settled in AUSD (Agora) on Monad" : "Signed and ready — Chainlink CRE executes automatically at expiry"}
                </span>
              </div>
            ) : (
              <>
                <div style={{ marginTop: 20, padding: 14, background: theme.bgAlt, borderRadius: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: theme.warn }}>⚠ Outside your tolerance — needs your approval</div>
                  <p style={{ marginTop: 6, fontSize: 13, color: theme.inkMuted, lineHeight: 1.5 }}>{cycle.reason}</p>
                </div>
                {error && <p style={{ marginTop: 12, fontSize: 13, color: theme.warn }}>{error}</p>}
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button
                    onClick={handleApprove}
                    disabled={busy}
                    style={{ flex: 1, padding: 12, background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: busy ? "default" : "pointer" }}
                  >
                    Approve anyway
                  </button>
                  <button
                    onClick={handleSkip}
                    disabled={busy}
                    style={{ flex: 1, padding: 12, background: "none", border: `1px solid ${theme.border}`, borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: busy ? "default" : "pointer", color: theme.ink }}
                  >
                    Skip this cycle
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ theme, label, value, mono, color }: { theme: ReturnType<typeof useAppTheme>["theme"]; label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ fontSize: 14, color: theme.inkMuted }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontFamily: mono ? "'JetBrains Mono',monospace" : undefined, color }}>{value}</span>
    </div>
  );
}
