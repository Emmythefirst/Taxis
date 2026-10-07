import { useNavigate, useParams } from "react-router-dom";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { formatUsd } from "../../app/format";
import { explorerTxUrl } from "../../app/explorer";

const SETTLED_CYCLE_CHECKS = [
  "Payment was due today",
  "Recipient is authorized",
  "Rate was within your tolerance",
  "Fee was below your limit",
  "Monthly spending limit not exceeded",
  "Balance was sufficient",
  "Quote had time remaining before expiry",
];

// A cycle that reached SETTLED via "Approve anyway" genuinely did breach
// tolerance at quote time — swapping this one line in keeps the checklist
// honest instead of claiming something that isn't true (Section A.11: real
// numbers, not a generic claim).
const SETTLED_CYCLE_CHECKS_MANUALLY_APPROVED = SETTLED_CYCLE_CHECKS.map((c) =>
  c === "Rate was within your tolerance" ? "Rate exceeded your tolerance — you approved it manually" : c,
);

const SETTLED_CHECKOUT_CHECKS = ["Merchant address matched the approved payment", "Amount was within the approved cap", "Balance was sufficient", "Quote had time remaining before expiry"];

export function Explain() {
  const { kind, id } = useParams<{ kind: "cycle" | "checkout"; id: string }>();
  const { theme } = useAppTheme();
  const { obligations, recipients, cycles, checkouts } = useAppData();
  const navigate = useNavigate();

  if (kind === "checkout") {
    const checkout = checkouts.find((c) => c.id === id);
    if (!checkout) return <NotFound theme={theme} onBack={() => navigate(-1)} />;
    const settled = checkout.status === "SETTLED";
    return (
      <ExplainCard
        theme={theme}
        onBack={() => navigate(-1)}
        heading={settled ? "Payment executed because" : checkout.status === "EXPIRED" ? "Payment expired — nothing was charged" : "Payment failed — nothing further was charged"}
        headColor={settled ? theme.success : theme.warn}
        amount={formatUsd(checkout.quote.ausdAmount)}
        settled={settled}
        checks={SETTLED_CHECKOUT_CHECKS}
        reason={checkout.reason}
        date={new Date(checkout.updatedAt).toLocaleString()}
        ref={checkout.quote.nonce}
        txHash={checkout.txHash}
      />
    );
  }

  const entry = cycles.find((c) => c.cycle.id === id);
  if (!entry) return <NotFound theme={theme} onBack={() => navigate(-1)} />;
  const { obligationId, cycle } = entry;
  const obligation = obligations.find((o) => o.id === obligationId);
  const recipient = recipients.find((r) => r.id === obligation?.recipientId);
  const settled = cycle.state === "SETTLED";
  const wasManuallyApproved = cycle.history.some((h) => h.to === "REQUIRES_APPROVAL");
  // Explain is only ever reached for a TERMINAL cycle (activityFeed.ts only
  // lists SETTLED/FAILED/SKIPPED/EXPIRED) — so this needs to distinguish
  // all three non-SETTLED endings, the same way the checkout branch above
  // already correctly does. It used to collapse FAILED and EXPIRED into
  // "Payment paused," the exact phrase REQUIRES_APPROVAL uses elsewhere —
  // wrong for a cycle that was actually attempted and rejected (e.g. a
  // kill-switch revocation causing a real Privy policy rejection), which
  // is a concluded, adverse outcome, not something still awaiting a
  // decision.
  const heading = settled
    ? "Payment executed because"
    : cycle.state === "SKIPPED"
      ? "Payment skipped — nothing was charged"
      : cycle.state === "EXPIRED"
        ? "Payment expired — nothing was charged"
        : "Payment failed — nothing was charged";

  return (
    <ExplainCard
      theme={theme}
      onBack={() => navigate(-1)}
      heading={heading}
      headColor={settled ? theme.success : theme.warn}
      amount={cycle.quote ? formatUsd(cycle.quote.ausdAmount) : `Paying ${recipient?.label ?? ""}`}
      settled={settled}
      checks={wasManuallyApproved ? SETTLED_CYCLE_CHECKS_MANUALLY_APPROVED : SETTLED_CYCLE_CHECKS}
      reason={cycle.reason}
      date={new Date(cycle.history[cycle.history.length - 1]?.at ?? cycle.dueAt).toLocaleString()}
      ref={cycle.quote?.nonce ?? cycle.id}
      txHash={cycle.txHash}
    />
  );
}

function NotFound({ theme, onBack }: { theme: ReturnType<typeof useAppTheme>["theme"]; onBack: () => void }) {
  return (
    <div style={{ maxWidth: 480 }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
        ← Back to activity
      </button>
      <p style={{ color: theme.inkMuted, fontSize: 14 }}>Not found.</p>
    </div>
  );
}

function ExplainCard(props: {
  theme: ReturnType<typeof useAppTheme>["theme"];
  onBack: () => void;
  heading: string;
  headColor: string;
  amount: string;
  settled: boolean;
  checks: string[];
  reason?: string;
  date: string;
  ref: string;
  txHash?: string;
}) {
  const { theme } = props;
  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 480 }}>
      <button onClick={props.onBack} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
        ← Back to activity
      </button>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: props.headColor, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>{props.heading}</div>
        <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", marginBottom: 18 }}>{props.amount}</div>

        {props.settled ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {props.checks.map((c) => (
              <div key={c} style={{ display: "flex", gap: 10 }}>
                <span style={{ color: theme.success, fontWeight: 700 }}>✓</span>
                <span style={{ fontSize: 14 }}>{c}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ color: theme.warn, fontWeight: 700 }}>⚠</span>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{props.reason ?? "No further detail recorded."}</span>
          </div>
        )}

        {props.settled && props.txHash && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Settlement</div>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, marginTop: 4 }}>
                {props.txHash.slice(0, 10)}…{props.txHash.slice(-8)}
              </div>
            </div>
            <a
              href={explorerTxUrl(props.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12.5, fontWeight: 600, color: theme.accent, textDecoration: "none" }}
            >
              View on explorer →
            </a>
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", fontSize: 12.5, color: theme.inkMuted }}>
          <span>{props.date}</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>Ref {props.ref} · protects against duplicate charges</span>
        </div>
      </div>
    </div>
  );
}
