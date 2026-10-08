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

  // Home used to show only the single most-imminent cycle ("Coming up") —
  // a user with three active payments had no way to see that from this
  // screen at all without clicking into Payments. A compact strip (not a
  // full duplicate of PaymentsList's detailed rows — that's one click
  // away) makes Home feel like an actual overview rather than a single
  // card plus empty space.
  const paymentsOverview = useMemo(() => {
    return obligations
      .filter((o) => o.status === "ACTIVE")
      .map((o) => {
        const needsReview = cycles.some(({ obligationId, cycle }) => obligationId === o.id && cycle.state === "REQUIRES_APPROVAL");
        return { obligation: o, recipient: recipientById.get(o.recipientId), needsReview };
      });
  }, [obligations, recipientById, cycles]);

  // Previously, a cycle needing review only showed up as a subtle warn-
  // colored left border on its row further down the page (or on Payments) —
  // nothing a user landing on Home would actually notice, especially since
  // these quotes carry their own short expiry (Section A.3) and can lapse
  // unreviewed. A banner at the very top states it plainly and links
  // straight to the single due cycle when there's exactly one, since that's
  // the common case and saves a click.
  const needsReviewCycles = useMemo(() => cycles.filter(({ cycle }) => cycle.state === "REQUIRES_APPROVAL"), [cycles]);

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

      {needsReviewCycles.length > 0 && (
        <div
          style={{
            marginTop: 20,
            padding: "14px 16px",
            background: pillColors(theme, dark, "warn").bg,
            border: `1px solid ${theme.warn}`,
            borderRadius: 4,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13.5, color: theme.warn, fontWeight: 600 }}>
            ⚠ {needsReviewCycles.length === 1
              ? `${recipientLabelForObligation(needsReviewCycles[0]!.obligationId)}'s payment needs your approval`
              : `${needsReviewCycles.length} payments need your approval`}
          </div>
          <button
            onClick={() =>
              needsReviewCycles.length === 1
                ? navigate(`/app/obligations/${needsReviewCycles[0]!.obligationId}/quotes/${needsReviewCycles[0]!.cycle.id}`)
                : navigate("/app/payments")
            }
            style={{ padding: "8px 14px", background: theme.warn, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: "pointer", flexShrink: 0 }}
          >
            Review now
          </button>
        </div>
      )}

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

      {/* The relationship between these two numbers used to be implicit —
          two cards, no sum, no stated connection. Stating the total
          explicitly ("$618, $203.84 of it already committed") is cheap and
          directly reinforces the bounded-authority thesis: Taxis only ever
          touches the reserved slice, never the available one, without a
          fresh quote. */}
      {balance !== undefined && (
        <div style={{ marginTop: 24, fontSize: 13, color: theme.inkMuted }}>
          Total balance{" "}
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: theme.ink }}>{formatUsd(Number(balance) + earmarked)}</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 10 }}>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 24 }}>
          <div style={{ fontSize: 12.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Available to spend</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, fontSize: 32, marginTop: 8 }}>
            {balance !== undefined ? `$${balance}` : "—"}
          </div>
        </div>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 24 }}>
          <div style={{ fontSize: 12.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Reserved for upcoming</div>
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
            View payment
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 32, padding: "22px 24px", border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.inkMuted, fontSize: 14 }}>
          Nothing scheduled right now.
        </div>
      )}

      {paymentsOverview.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>
              Your payments ({paymentsOverview.length})
            </h2>
            <button onClick={() => navigate("/app/payments")} style={{ background: "none", border: "none", color: theme.accent, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              View all
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
            {paymentsOverview.map(({ obligation: o, recipient, needsReview }) => (
              <div
                key={o.id}
                onClick={() => navigate("/app/payments")}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "13px 16px",
                  borderBottom: `1px solid ${theme.border}`,
                  borderLeft: `3px solid ${needsReview ? theme.warn : "transparent"}`,
                  background: needsReview ? pillColors(theme, dark, "warn").bg : theme.surface,
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{recipient?.label ?? "Recipient"}</span>
                <span style={{ fontSize: 12.5, color: needsReview ? theme.warn : theme.inkMuted, fontWeight: needsReview ? 600 : 400 }}>
                  {needsReview ? "Needs review" : `up to $${o.maxAusdCost}`}
                </span>
              </div>
            ))}
          </div>
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
          onClick={() => navigate("/app/pay")}
          style={{ flex: 1, padding: 14, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: "pointer", color: theme.ink }}
        >
          Request or pay someone
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
