import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { COUNTRY_OPTIONS } from "../../app/countries";
import * as endpoints from "../../api/endpoints";
import type { Cadence, Hex } from "../../types";

const CADENCE_OPTIONS = ["Weekly", "Monthly"] as const;
const TOLERANCE_OPTIONS = ["2%", "5%", "10%"] as const;

// Not collected in the design's form — reasonable fixed defaults for this
// build, matching the same values used throughout the backend's demo/e2e
// obligations. maxFeeAusd: a small flat ceiling on itemized fees, separate
// from the FX ceiling. quoteExpirySeconds: 5 minutes, consistent with every
// other quote-expiry default in this codebase.
const DEFAULT_MAX_FEE_AUSD = 3;
const DEFAULT_QUOTE_EXPIRY_SECONDS = 300;

/**
 * cumulativeCapAusd is a genuine rolling CALENDAR-MONTH cap
 * (scheduler/runDueCycles.ts computes `period` as `YYYY-MM` — a real
 * design choice, not an implementation detail: it's what backs the Explain
 * screen's "Monthly spending limit not exceeded" line). A single cycle's
 * own ceiling (`maxAusdCost`) is the WRONG default for anything but a
 * MONTHLY cadence: a WEEKLY obligation can have up to 5 cycles land in one
 * calendar month, and defaulting the cumulative cap to one cycle's cost
 * would let the first cycle of the month consume the entire allowance,
 * silently SKIPPING every subsequent cycle that month — confirmed by a real
 * regression test (backend/test/cumulativeCapRegression.test.ts) before
 * this was caught in review, not after a live demo hit it. Sized to the
 * worst case per cadence so a legitimate month's worth of cycles always
 * fits.
 */
function maxCyclesPerCalendarMonth(cadence: Cadence["kind"]): number {
  switch (cadence) {
    case "WEEKLY":
      return 5;
    case "BIWEEKLY":
      return 3;
    case "MONTHLY":
      return 1;
  }
}

function chipStyle(theme: ReturnType<typeof useAppTheme>["theme"], active: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 16,
    border: `1px solid ${active ? theme.accent : theme.border}`,
    background: active ? theme.accent : "transparent",
    color: active ? "#fff" : theme.ink,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function parseAmount(raw: string): number {
  return Number(raw.replace(/,/g, "").trim());
}

export function NewPayment() {
  const { theme } = useAppTheme();
  const { userId, walletAddress, setAgentQuorumId, refresh } = useAppData();
  const { addSigners } = useSigners();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [country, setCountry] = useState(COUNTRY_OPTIONS[0]!.name);
  const [amount, setAmount] = useState("2,400");
  const [cadence, setCadence] = useState<(typeof CADENCE_OPTIONS)[number]>("Monthly");
  const [ceiling, setCeiling] = useState("85");
  const [tolerance, setTolerance] = useState<(typeof TOLERANCE_OPTIONS)[number]>("5%");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const selectedCountry = COUNTRY_OPTIONS.find((c) => c.name === country) ?? COUNTRY_OPTIONS[0]!;

  async function handleSubmit() {
    setError(undefined);
    if (!name.trim()) return setError("Enter a recipient name.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress.trim())) return setError("Enter a valid payout address (0x… 40 hex characters).");
    const targetLocalAmount = parseAmount(amount);
    const maxAusdCost = parseAmount(ceiling);
    if (!targetLocalAmount || targetLocalAmount <= 0) return setError("Enter a valid amount.");
    if (!maxAusdCost || maxAusdCost <= 0) return setError("Enter a valid spending ceiling.");
    if (!walletAddress) return setError("Your wallet isn't linked yet — try logging out and back in.");

    const cadenceValue: Cadence =
      cadence === "Weekly" ? { kind: "WEEKLY", dayOfWeek: new Date().getUTCDay() } : { kind: "MONTHLY", dayOfMonth: new Date().getUTCDate() };

    setSubmitting(true);
    try {
      const { recipient } = await endpoints.createRecipient(userId, {
        label: name.trim(),
        payoutAddress: payoutAddress.trim() as Hex,
        localCurrency: selectedCountry.currency,
      });

      const created = await endpoints.createObligation(userId, {
        recipientId: recipient.id,
        targetLocalAmount,
        localCurrency: selectedCountry.currency,
        maxAusdCost,
        maxFeeAusd: DEFAULT_MAX_FEE_AUSD,
        cumulativeCapAusd: maxAusdCost * maxCyclesPerCalendarMonth(cadenceValue.kind),
        cadence: cadenceValue,
        quoteExpirySeconds: DEFAULT_QUOTE_EXPIRY_SECONDS,
      });
      setAgentQuorumId(created.agentQuorumId);

      // The real owner-signed tap (Section A.4 step 4) — this IS the
      // permission grant, not a formality. Everything before this point is
      // just preparation; nothing is authorized on Privy's side until this
      // succeeds.
      await addSigners({ address: walletAddress, signers: [{ signerId: created.agentQuorumId, policyIds: [created.policyId] }] });

      await endpoints.recordGrant(created.obligation.id, { policyId: created.policyId, expiresAtUnix: created.expiresAtUnix, kind: "CYCLE" });

      await refresh();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 420, textAlign: "center", padding: "60px 0" }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: theme.success,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            fontWeight: 700,
            margin: "0 auto",
            animation: "stampIn 0.5s ease both",
          }}
        >
          ✓
        </div>
        <h1 style={{ marginTop: 20, fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 22 }}>Payment set up</h1>
        <p style={{ marginTop: 8, fontSize: 14.5, color: theme.inkMuted }}>Taxis will generate a fresh quote every cycle and check it against your limits.</p>
        <button
          onClick={() => navigate("/app/payments")}
          style={{ marginTop: 24, padding: "13px 22px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}
        >
          Back to payments
        </button>
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both" }}>
      <button onClick={() => navigate("/app/payments")} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
        ← Back to payments
      </button>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 24 }}>New payment</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 32, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Recipient</span>
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(theme)} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Payout address</span>
            <input value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="0x…" style={{ ...inputStyle(theme), fontFamily: "'JetBrains Mono',monospace" }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Country</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {COUNTRY_OPTIONS.map((c) => (
                <button key={c.name} onClick={() => setCountry(c.name)} style={chipStyle(theme, c.name === country)}>
                  {c.name}
                </button>
              ))}
            </div>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>They get, per cycle</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle(theme), fontFamily: "'JetBrains Mono',monospace" }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>How often</span>
            <div style={{ display: "flex", gap: 8 }}>
              {CADENCE_OPTIONS.map((c) => (
                <button key={c} onClick={() => setCadence(c)} style={chipStyle(theme, c === cadence)}>
                  {c}
                </button>
              ))}
            </div>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Your spending ceiling per cycle</span>
            <input value={ceiling} onChange={(e) => setCeiling(e.target.value)} style={{ ...inputStyle(theme), fontFamily: "'JetBrains Mono',monospace" }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Rate tolerance</span>
            <div style={{ display: "flex", gap: 8 }}>
              {TOLERANCE_OPTIONS.map((t) => (
                <button key={t} onClick={() => setTolerance(t)} style={chipStyle(theme, t === tolerance)}>
                  {t}
                </button>
              ))}
            </div>
          </label>
        </div>

        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 22, position: "sticky", top: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 16 }}>Preview</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Row theme={theme} label="Recipient" value={`${name || "—"} · ${country}`} />
            <Row theme={theme} label="They get" value={`${amount} ${selectedCountry.currency} / ${cadence}`} mono />
            <Row theme={theme} label="Your ceiling" value={`$${ceiling}`} mono />
            <Row theme={theme} label="Rate tolerance" value={tolerance} />
          </div>
          {error && <p style={{ marginTop: 14, fontSize: 13, color: theme.warn }}>{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              marginTop: 22,
              width: "100%",
              padding: 13,
              background: theme.accent,
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 14.5,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Setting up…" : "Set up payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ theme, label, value, mono }: { theme: ReturnType<typeof useAppTheme>["theme"]; label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ fontSize: 13.5, color: theme.inkMuted }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 600, fontFamily: mono ? "'JetBrains Mono',monospace" : undefined }}>{value}</span>
    </div>
  );
}

function inputStyle(theme: ReturnType<typeof useAppTheme>["theme"]): CSSProperties {
  return { padding: "12px 14px", border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.surface, color: theme.ink, fontSize: 14.5 };
}
