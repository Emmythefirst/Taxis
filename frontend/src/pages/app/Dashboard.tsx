import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { buildActivityFeed } from "../../app/activityFeed";
import { formatUsd } from "../../app/format";
import { pillColors } from "../../theme/theme";

const NON_TERMINAL: ReadonlySet<string> = new Set(["PENDING_QUOTE", "QUOTED", "FUNDS_RESERVED", "AUTO_APPROVED", "REQUIRES_APPROVAL", "EXECUTING"]);
const RENEWAL_WARNING_WINDOW_MS = 48 * 60 * 60 * 1000;
// Section A.7: cap suggested funding to a few cycles' worth, never idle
// savings — this is a suggestion for the user's own manual testnet
// transfer, not an automated top-up (no real fiat on-ramp exists).
const SUGGESTED_FUNDING_AUSD = 50;
const LOW_BALANCE_THRESHOLD_AUSD = 5;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function Dashboard() {
  const { theme, dark } = useAppTheme();
  const { balance, walletAddress, recipients, obligations, cycles, grants, checkouts } = useAppData();
  const navigate = useNavigate();
  const [addressCopied, setAddressCopied] = useState(false);

  const recipientById = useMemo(() => new Map(recipients.map((r) => [r.id, r])), [recipients]);
  const obligationById = useMemo(() => new Map(obligations.map((o) => [o.id, o])), [obligations]);
  const recipientLabelForObligation = (obligationId: string) => recipientById.get(obligationById.get(obligationId)?.recipientId ?? "")?.label ?? "Payment";

  const earmarked = useMemo(
    () =>
      cycles
        .filter(({ cycle }) => NON_TERMINAL.has(cycle.state) && cycle.quote)
        .reduce((sum, { cycle }) => sum + Number(cycle.quote!.ausdAmount), 0),
    [cycles],
  );

  const comingUp = useMemo(() => {
    const upcoming = cycles
      .filter(({ cycle }) => NON_TERMINAL.has(cycle.state))
      .sort((a, b) => new Date(a.cycle.dueAt).getTime() - new Date(b.cycle.dueAt).getTime());
    return upcoming[0];
  }, [cycles]);

  const recentActivity = useMemo(
    () => buildActivityFeed(cycles, checkouts, recipientLabelForObligation).slice(0, 3),
    [cycles, checkouts, recipientById, obligationById],
  );

  const renewalNeeded = useMemo(() => {
    return obligations
      .filter((o) => o.status === "ACTIVE")
      .some((o) => {
        const activeGrant = grants
          .filter((g) => g.obligationId === o.id && g.grant.kind === "CYCLE" && g.grant.status === "ACTIVE")
          .sort((a, b) => new Date(b.grant.expiresAt).getTime() - new Date(a.grant.expiresAt).getTime())[0]?.grant;
        return !activeGrant || new Date(activeGrant.expiresAt).getTime() - Date.now() < RENEWAL_WARNING_WINDOW_MS;
      });
  }, [obligations, grants]);

  const showFundingGuidance = balance !== undefined && Number(balance) < LOW_BALANCE_THRESHOLD_AUSD;

  async function copyAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // address is still shown and selectable, so this is non-fatal.
    }
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both" }}>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em" }}>{greeting()}</h1>

      {renewalNeeded && (
        <div
          onClick={() => navigate("/app/settings")}
          style={{ marginTop: 20, padding: "12px 16px", background: theme.bgAlt, border: `1px solid ${theme.warn}`, borderRadius: 4, fontSize: 13.5, color: theme.warn, cursor: "pointer" }}
        >
          ⚠ A payment permission needs renewing soon — go to Settings to renew.
        </div>
      )}

      {showFundingGuidance && walletAddress && (
        <div style={{ marginTop: 20, padding: 18, background: theme.bgAlt, borderRadius: 6, fontSize: 13.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Add AUSD to get started</div>
          <p style={{ color: theme.inkMuted, marginBottom: 10 }}>
            We suggest funding a few cycles at a time (~${SUGGESTED_FUNDING_AUSD}), not your whole balance. Send testnet AUSD to your wallet:
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, background: theme.surface, padding: "6px 10px", borderRadius: 4, wordBreak: "break-all" }}>{walletAddress}</code>
            <button onClick={copyAddress} style={{ padding: "6px 10px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
              {addressCopied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 24 }}>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 24 }}>
          <div style={{ fontSize: 12.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Available to spend</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, fontSize: 32, marginTop: 8 }}>
            {balance !== undefined ? `$${balance}` : "—"}
          </div>
        </div>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 24 }}>
          <div style={{ fontSize: 12.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Earmarked for upcoming</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, fontSize: 32, marginTop: 8, color: theme.inkMuted }}>
            {formatUsd(earmarked)}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: theme.inkMuted }}>Settled in AUSD (Agora) on Monad · scheduled by Chainlink CRE</div>

      {comingUp ? (
        <div
          style={{
            marginTop: 32,
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            padding: "22px 24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 12.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Coming up</div>
            <div style={{ marginTop: 6, fontSize: 15, fontWeight: 600 }}>
              {recipientLabelForObligation(comingUp.obligationId)} · {new Date(comingUp.cycle.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </div>
            {comingUp.cycle.quote && (
              <div style={{ marginTop: 2, fontSize: 13.5, color: theme.inkMuted }}>Estimated cost: {formatUsd(comingUp.cycle.quote.ausdAmount)}</div>
            )}
          </div>
          <button
            onClick={() => navigate(`/app/obligations/${comingUp.obligationId}/quotes/${comingUp.cycle.id}`)}
            style={{ padding: "11px 18px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
          >
            View quote
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 32, padding: "22px 24px", border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.inkMuted, fontSize: 14 }}>
          Nothing scheduled right now.
        </div>
      )}

      <div style={{ marginTop: 32, display: "flex", gap: 12 }}>
        <button
          onClick={() => navigate("/app/payments/new")}
          style={{ flex: 1, padding: 14, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: "pointer", color: theme.ink }}
        >
          + New payment
        </button>
        <button
          onClick={() => navigate("/app/checkout")}
          style={{ flex: 1, padding: 14, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: "pointer", color: theme.ink }}
        >
          Checkout demo
        </button>
      </div>

      <div style={{ marginTop: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Recent activity</h2>
          <button onClick={() => navigate("/app/activity")} style={{ background: "none", border: "none", color: theme.accent, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            View all
          </button>
        </div>
        {recentActivity.length === 0 ? (
          <div style={{ color: theme.inkMuted, fontSize: 14 }}>No activity yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
            {recentActivity.map((a) => {
              const colors = pillColors(theme, dark, a.status.kind);
              return (
                <button
                  key={a.id}
                  onClick={() => navigate(`/app/activity/${a.kind}/${a.id}`)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px 18px",
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
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div>
                    <div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 2 }}>{new Date(a.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 12, background: colors.bg, color: colors.color }}>
                    {a.status.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
