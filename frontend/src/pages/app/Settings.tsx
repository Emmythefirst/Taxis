import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLogout, useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import * as endpoints from "../../api/endpoints";

const RENEWAL_WARNING_WINDOW_MS = 48 * 60 * 60 * 1000; // Section A.4 step 6: "shortly before" the window lapses

/**
 * Kill switch is wired for real: Section A.8's actual meaning is a GLOBAL
 * stop ("revoke the agent's session-key authority instantly"), which maps
 * directly onto `useSigners().removeSigners({address})` — clears every
 * signer on the wallet in one owner-signed tap, independent of how many
 * rules the shared operations policy happens to contain (progress.md,
 * 2026-09-13's combined-policy fix). After that real revocation succeeds,
 * this also syncs Taxis's own bookkeeping for every currently-ACTIVE
 * obligation via the existing per-obligation endpoint.
 *
 * Backup recipient now links to its own distinct setup flow
 * (pages/app/ContinuitySetup.tsx) — per the finalized dead-man's-switch
 * design (Section A.8), continuity needs a separate owner-signed
 * authorization step, never a field on this screen.
 *
 * "Active permissions" also surfaces each obligation's real grant expiry
 * and a real "Renew" tap (Section A.4 step 6) once it's within 48 hours of
 * lapsing or already has — without this, a payment just silently stops
 * working with no visible explanation.
 */
export function Settings() {
  const { theme } = useAppTheme();
  const { userId, walletAddress, recipients, obligations, grants, continuity, refresh } = useAppData();
  const { removeSigners, addSigners } = useSigners();
  const navigate = useNavigate();
  const { logout } = useLogout({ onSuccess: () => navigate("/", { replace: true }) });

  const [killConfirm, setKillConfirm] = useState(false);
  const [killed, setKilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [renewingId, setRenewingId] = useState<string | undefined>(undefined);

  const activeObligations = obligations.filter((o) => o.status === "ACTIVE");
  const recipientById = new Map(recipients.map((r) => [r.id, r]));
  const backupRecipient = continuity?.backupRecipientId ? recipientById.get(continuity.backupRecipientId) : undefined;

  function activeCycleGrantFor(obligationId: string) {
    return grants
      .filter((g) => g.obligationId === obligationId && g.grant.kind === "CYCLE" && g.grant.status === "ACTIVE")
      .sort((a, b) => new Date(b.grant.expiresAt).getTime() - new Date(a.grant.expiresAt).getTime())[0]?.grant;
  }

  async function confirmKill() {
    if (!walletAddress) return;
    setBusy(true);
    setError(undefined);
    try {
      await removeSigners({ address: walletAddress });
      await Promise.all(activeObligations.map((o) => endpoints.killSwitch(o.id, userId)));
      await refresh();
      setKilled(true);
      setKillConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenew(obligationId: string) {
    if (!walletAddress) return;
    setRenewingId(obligationId);
    setError(undefined);
    try {
      const renewed = await endpoints.renewObligation(obligationId);
      await addSigners({ address: walletAddress, signers: [{ signerId: renewed.agentQuorumId, policyIds: [renewed.policyId] }] });
      await endpoints.recordGrant(obligationId, { policyId: renewed.policyId, expiresAtUnix: renewed.expiresAtUnix, kind: "CYCLE" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenewingId(undefined);
    }
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 620 }}>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 28 }}>Settings</h1>

      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 22, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Backup recipient</h2>
        <p style={{ fontSize: 13.5, color: theme.inkMuted, marginBottom: 16 }}>If you go quiet, payments redirect here instead of stalling.</p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13.5, color: theme.inkMuted }}>Redirect after inactivity of</span>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{continuity?.inactivityThresholdDays ? `${continuity.inactivityThresholdDays} days` : "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13.5, color: theme.inkMuted }}>Backup recipient</span>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{backupRecipient ? backupRecipient.label : "Not set up yet"}</span>
        </div>
        <button
          onClick={() => navigate("/app/settings/continuity")}
          style={{ marginTop: 16, padding: "9px 14px", background: "none", border: `1px solid ${theme.border}`, borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: "pointer", color: theme.ink }}
        >
          {continuity?.configured ? "Change backup recipient" : "Set up backup recipient"}
        </button>
      </div>

      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 22, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Active permissions</h2>
        {activeObligations.length === 0 ? (
          <p style={{ fontSize: 13.5, color: theme.inkMuted }}>No active payments.</p>
        ) : (
          activeObligations.map((o) => {
            const grant = activeCycleGrantFor(o.id);
            const expiresAt = grant ? new Date(grant.expiresAt) : undefined;
            const needsRenewal = expiresAt ? expiresAt.getTime() - Date.now() < RENEWAL_WARNING_WINDOW_MS : true;
            return (
              <div key={o.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${theme.border}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{recipientById.get(o.recipientId)?.label ?? o.id}</div>
                  <div style={{ fontSize: 12.5, color: needsRenewal ? theme.warn : theme.inkMuted, marginTop: 2 }}>
                    up to ${o.maxAusdCost} / cycle · {expiresAt ? (expiresAt.getTime() < Date.now() ? "expired" : `until ${expiresAt.toLocaleDateString()}`) : "no active grant"}
                  </div>
                </div>
                {needsRenewal && (
                  <button
                    onClick={() => handleRenew(o.id)}
                    disabled={renewingId === o.id}
                    style={{ padding: "8px 12px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontSize: 12.5, fontWeight: 600, cursor: renewingId === o.id ? "default" : "pointer" }}
                  >
                    {renewingId === o.id ? "Renewing…" : "Renew"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div style={{ background: theme.surface, border: `1px solid ${theme.warn}`, borderRadius: 6, padding: 22 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: theme.warn }}>Kill switch</h2>
        <p style={{ fontSize: 13.5, color: theme.inkMuted, marginBottom: 16 }}>Stops all of Taxis's access immediately. Your money is never touched — it stays exactly where it is.</p>
        {error && <p style={{ marginBottom: 12, fontSize: 13, color: theme.warn }}>{error}</p>}
        {!killConfirm ? (
          !killed ? (
            <button
              onClick={() => setKillConfirm(true)}
              style={{ padding: "12px 20px", background: theme.warn, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer" }}
            >
              Pause Taxis now
            </button>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.warn }}>Taxis is paused — nothing will execute</span>
              <span style={{ fontSize: 12.5, color: theme.inkMuted }}>Set up a payment again to resume</span>
            </div>
          )
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={confirmKill}
              disabled={busy}
              style={{ flex: 1, padding: 12, background: theme.warn, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "Pausing…" : "Yes, pause everything"}
            </button>
            <button
              onClick={() => setKillConfirm(false)}
              disabled={busy}
              style={{ flex: 1, padding: 12, background: "none", border: `1px solid ${theme.border}`, borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer", color: theme.ink }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 20, textAlign: "center" }}>
        <button
          onClick={() => logout()}
          style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}
        >
          Log out
        </button>
      </div>
    </div>
  );
}
