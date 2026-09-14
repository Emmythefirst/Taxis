import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import * as endpoints from "../../api/endpoints";

const INACTIVITY_OPTIONS = [30, 60, 90] as const;

/**
 * Continuity's own distinct authorization step (Section A.8's finalized
 * design) — deliberately NOT a field on the Settings screen, since it
 * creates a genuinely separate grant (against the dedicated CONTINUITY
 * quorum) rather than editing the day-to-day one. Applies to every
 * currently-active obligation at once, matching the single backup-
 * recipient setting the design's Settings screen shows.
 */
export function ContinuitySetup() {
  const { theme } = useAppTheme();
  const { userId, walletAddress, recipients, obligations, refresh } = useAppData();
  const { addSigners } = useSigners();
  const navigate = useNavigate();

  const [backupRecipientId, setBackupRecipientId] = useState<string | undefined>(recipients[0]?.id);
  const [inactivityDays, setInactivityDays] = useState<(typeof INACTIVITY_OPTIONS)[number]>(60);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const activeObligations = obligations.filter((o) => o.status === "ACTIVE");

  async function handleSubmit() {
    setError(undefined);
    if (!backupRecipientId) return setError("Choose a backup recipient.");
    if (!walletAddress) return setError("Your wallet isn't linked yet.");

    setSubmitting(true);
    try {
      const setup = await endpoints.setupContinuity(userId, { backupRecipientId, inactivityThresholdDays: inactivityDays });

      // The real, distinct owner-signed tap — against the CONTINUITY
      // quorum specifically, never the day-to-day agent one.
      await addSigners({ address: walletAddress, signers: [{ signerId: setup.continuityQuorumId, policyIds: [setup.policyId] }] });

      await endpoints.recordContinuityGrant(userId, { policyId: setup.policyId, expiresAtUnix: setup.expiresAtUnix, inactivityThresholdDays: inactivityDays });
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
      <div style={{ maxWidth: 460, textAlign: "center", padding: "60px 0" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: theme.success, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 700, margin: "0 auto", animation: "stampIn 0.5s ease both" }}>
          ✓
        </div>
        <h1 style={{ marginTop: 20, fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 22 }}>Continuity set up</h1>
        <p style={{ marginTop: 8, fontSize: 14.5, color: theme.inkMuted }}>
          If you go quiet for {inactivityDays} days, your scheduled payments will redirect to your backup recipient instead of stalling.
        </p>
        <button onClick={() => navigate("/app/settings")} style={{ marginTop: 24, padding: "13px 22px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}>
          Back to settings
        </button>
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 460 }}>
      <button onClick={() => navigate("/app/settings")} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13.5, cursor: "pointer", marginBottom: 16 }}>
        ← Back to settings
      </button>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 10 }}>Set up continuity</h1>
      <p style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 1.55, marginBottom: 24 }}>
        This is a separate permission from your day-to-day payments — a dedicated grant that only ever activates if you go quiet. It protects{" "}
        {activeObligations.length} active payment{activeObligations.length === 1 ? "" : "s"}.
      </p>

      {recipients.length === 0 ? (
        <p style={{ fontSize: 14, color: theme.warn }}>Add a recipient first (from New Payment) before setting up a backup.</p>
      ) : (
        <>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, marginBottom: 8 }}>Backup recipient</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {recipients.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setBackupRecipientId(r.id)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 16,
                    border: `1px solid ${r.id === backupRecipientId ? theme.accent : theme.border}`,
                    background: r.id === backupRecipientId ? theme.accent : "transparent",
                    color: r.id === backupRecipientId ? "#fff" : theme.ink,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, marginBottom: 8 }}>Redirect after inactivity of</div>
            <div style={{ display: "flex", gap: 6 }}>
              {INACTIVITY_OPTIONS.map((days) => (
                <button
                  key={days}
                  onClick={() => setInactivityDays(days)}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 14,
                    border: `1px solid ${days === inactivityDays ? theme.accent : theme.border}`,
                    background: days === inactivityDays ? theme.accent : "transparent",
                    color: days === inactivityDays ? "#fff" : theme.ink,
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {days} days
                </button>
              ))}
            </div>
          </div>

          {error && <p style={{ marginBottom: 14, fontSize: 13, color: theme.warn }}>{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ width: "100%", padding: 14, background: theme.accent, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 15, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? "Setting up…" : "Set up continuity"}
          </button>
        </>
      )}
    </div>
  );
}
