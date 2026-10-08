import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { useCountdown } from "../../app/useCountdown";
import { formatUsd, formatLocalAmount } from "../../app/format";
import { explorerTxUrl } from "../../app/explorer";
import { reattachAgentSigner } from "../../app/reattachSigners";
import * as endpoints from "../../api/endpoints";
import type { PaymentRequest } from "../../types";

type Stage = "loading" | "not-found" | "unpayable" | "own-request" | "insufficient" | "review" | "processing" | "done" | "error";

/**
 * The PAYER's review/approve screen — reached either by scanning a QR
 * (ScanToPay.tsx), tapping a shared link directly, or being redirected
 * after Pay fails and retrying. Mirrors CheckoutDemo's old stage machine:
 * the real AUSD quote (with its fee breakdown and short expiry) is fetched
 * as soon as the request is confirmed payable — BEFORE the user sees a Pay
 * button, not after tapping it — so "Pay" always means approving an exact,
 * already-known total, never a blind commit. "Pay" itself then only does
 * the owner-signed reattach + execute against that already-quoted checkout.
 */
export function PayRequest() {
  const { requestId } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const { theme } = useAppTheme();
  const { userId, walletAddress, continuity, refresh } = useAppData();
  const { addSigners, removeSigners } = useSigners();

  const [stage, setStage] = useState<Stage>("loading");
  const [request, setRequest] = useState<PaymentRequest | undefined>(undefined);
  const [checkoutId, setCheckoutId] = useState<string | undefined>(undefined);
  const [policyId, setPolicyId] = useState<string | undefined>(undefined);
  const [agentQuorumId, setAgentQuorumId] = useState<string | undefined>(undefined);
  const [quoteExpiresAt, setQuoteExpiresAt] = useState<string | undefined>(undefined);
  const [feeAusd, setFeeAusd] = useState<number | undefined>(undefined);
  const [totalAusd, setTotalAusd] = useState<number | undefined>(undefined);
  const [doneTxHash, setDoneTxHash] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const expiryLabel = useCountdown(quoteExpiresAt);

  useEffect(() => {
    void loadRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  async function loadRequest() {
    if (!requestId) return;
    setStage("loading");
    setError(undefined);
    try {
      const { request: req } = await endpoints.getPaymentRequest(requestId);
      setRequest(req);
      if (req.requesterUserId === userId) {
        setStage("own-request");
        return;
      }
      if (req.status !== "PENDING" || new Date(req.expiresAt).getTime() <= Date.now()) {
        setStage("unpayable");
        return;
      }
      await requestQuote(requestId);
    } catch (err) {
      setStage("not-found");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function requestQuote(id: string) {
    try {
      const result = await endpoints.payPaymentRequest(id, userId);
      if (result.outcome === "INSUFFICIENT_BALANCE") {
        setStage("insufficient");
        return;
      }
      setCheckoutId(result.checkout.id);
      setPolicyId(result.policyId);
      setAgentQuorumId(result.agentQuorumId);
      setQuoteExpiresAt(result.checkout.quote.expiresAt);
      setFeeAusd(Number(result.checkout.quote.feeAgentAusd) + Number(result.checkout.quote.feeNetworkAusd));
      setTotalAusd(Number(result.checkout.quote.ausdAmount));
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function handlePay() {
    if (!checkoutId || !policyId || !agentQuorumId || !walletAddress) return;
    setStage("processing");
    setError(undefined);
    try {
      // The real owner-signed "Approve payment" tap — same reattach
      // discipline as CheckoutDemo/Renew/Cancel: the agent quorum is
      // almost always already attached from an existing obligation, and
      // addSigners() rejects re-adding an already-attached signerId
      // outright (see app/reattachSigners.ts).
      await reattachAgentSigner({
        addSigners,
        removeSigners,
        walletAddress,
        continuity,
        agent: { agentQuorumId, policyId },
      });
      const result = await endpoints.executeCheckout(checkoutId);
      if (result.outcome === "SETTLED" || result.outcome === "PENDING_CONFIRMATION") {
        setDoneTxHash(result.txHash);
        await refresh();
        setStage("done");
      } else {
        setError(result.reason);
        setStage("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function copyTxHash() {
    if (!doneTxHash) return;
    try {
      await navigator.clipboard.writeText(doneTxHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // hash is still shown and selectable, so this is non-fatal.
    }
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 420 }}>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 24 }}>Pay request</h1>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26, textAlign: "center" }}>
        {stage === "loading" && <div style={{ padding: "30px 0", color: theme.inkMuted, fontSize: 14 }}>Checking rate, fee, and your balance…</div>}

        {stage === "not-found" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>Request not found.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>The link might be mistyped, or the request no longer exists.</p>
          </div>
        )}

        {stage === "own-request" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>This is your own request.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>Share the link or QR with whoever owes you instead.</p>
          </div>
        )}

        {stage === "unpayable" && request && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>
              {request.status === "FULFILLED" ? "Already paid." : request.status === "CANCELLED" ? "This request was cancelled." : "This request has expired."}
            </div>
          </div>
        )}

        {stage === "insufficient" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>Not enough balance to pay this.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>Add funds to your wallet and try again.</p>
          </div>
        )}

        {stage === "error" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>Something went wrong.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>{error}</p>
            <button
              onClick={loadRequest}
              style={{ marginTop: 16, padding: "10px 16px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        )}

        {stage === "review" && request && totalAusd !== undefined && feeAusd !== undefined && (
          <>
            <div style={{ fontSize: 13, color: theme.inkMuted, marginBottom: 8 }}>Paying</div>
            <div style={{ fontSize: 15.5, fontWeight: 700 }}>
              {request.requesterAddress.slice(0, 6)}…{request.requesterAddress.slice(-4)}
            </div>
            {request.memo && <div style={{ marginTop: 4, fontSize: 13.5, color: theme.inkMuted }}>{request.memo}</div>}
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 34, fontWeight: 600, marginTop: 16 }}>{formatUsd(totalAusd)}</div>
            <div style={{ fontSize: 12, color: theme.warn, marginTop: 6 }}>Quote expires in {expiryLabel}</div>

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${theme.border}`, textAlign: "left" }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 10 }}>Payment summary</div>
              <SummaryRow theme={theme} label="Requested" value={formatLocalAmount(request.localAmount, request.localCurrency)} />
              <SummaryRow theme={theme} label="Taxis fee" value={formatUsd(feeAusd)} />
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${theme.border}` }}>
                <SummaryRow theme={theme} label="Total" value={formatUsd(totalAusd)} bold />
              </div>
            </div>

            <div style={{ marginTop: 14, fontSize: 11.5, color: theme.inkMuted }}>Paid with Taxis · AUSD (Agora) on Monad</div>

            <button
              onClick={handlePay}
              style={{ marginTop: 20, width: "100%", padding: 14, background: theme.accent, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 15, cursor: "pointer" }}
            >
              Pay {formatUsd(totalAusd)}
            </button>
            <div style={{ marginTop: 10, fontSize: 11.5, color: theme.inkMuted }}>🔒 You are approving this exact amount, once.</div>
          </>
        )}

        {stage === "processing" && (
          <div style={{ padding: "30px 0" }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${theme.border}`, borderTopColor: theme.accent, borderRadius: "50%", margin: "0 auto", animation: "spin360 0.8s linear infinite" }} />
            <div style={{ marginTop: 16, fontSize: 14, color: theme.inkMuted }}>{totalAusd !== undefined ? `Sending ${formatUsd(totalAusd)}…` : "Sending payment…"}</div>
          </div>
        )}

        {stage === "done" && (
          <>
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
            <h1 style={{ marginTop: 20, fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 20 }}>Paid</h1>
            <p style={{ marginTop: 6, fontSize: 13.5, color: theme.inkMuted }}>{totalAusd !== undefined ? formatUsd(totalAusd) : ""} sent.</p>
            {doneTxHash && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}`, display: "flex", flexDirection: "column", gap: 8, textAlign: "left" }}>
                <div style={{ fontSize: 11, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Settlement</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5 }}>
                    {doneTxHash.slice(0, 10)}…{doneTxHash.slice(-8)}
                  </span>
                  <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                    <button onClick={copyTxHash} style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <a href={explorerTxUrl(doneTxHash)} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent, fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
                      View on explorer →
                    </a>
                  </div>
                </div>
              </div>
            )}
            <button
              onClick={() => navigate("/app/pay")}
              style={{ marginTop: 22, width: "100%", padding: 13, background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ theme, label, value, bold }: { theme: ReturnType<typeof useAppTheme>["theme"]; label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: bold ? 0 : 6 }}>
      <span style={{ fontSize: bold ? 13.5 : 13, color: bold ? theme.ink : theme.inkMuted, fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: bold ? 13.5 : 13, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{value}</span>
    </div>
  );
}
