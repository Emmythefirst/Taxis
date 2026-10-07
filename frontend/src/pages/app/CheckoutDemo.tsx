import { useEffect, useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { useCountdown } from "../../app/useCountdown";
import { formatUsd } from "../../app/format";
import { explorerTxUrl } from "../../app/explorer";
import * as endpoints from "../../api/endpoints";
import type { Hex } from "../../types";

const DEMO_MERCHANT_ADDRESS = import.meta.env.VITE_DEMO_MERCHANT_ADDRESS as string | undefined;
const DEMO_MERCHANT_NAME = "Kaya Market";
const DEMO_AMOUNT_USD = 18.5;

type Stage = "loading" | "insufficient" | "review" | "processing" | "done" | "error";

export function CheckoutDemo() {
  const { theme } = useAppTheme();
  const { userId, walletAddress, refresh } = useAppData();
  const { addSigners } = useSigners();

  const [stage, setStage] = useState<Stage>("loading");
  const [checkoutId, setCheckoutId] = useState<string | undefined>(undefined);
  const [policyId, setPolicyId] = useState<string | undefined>(undefined);
  const [agentQuorumId, setAgentQuorumId] = useState<string | undefined>(undefined);
  const [expiresAt, setExpiresAt] = useState<string | undefined>(undefined);
  // feeAusd and totalAusd as numbers, not pre-formatted strings — needed to
  // derive the item/fee/total breakdown below, and critically: totalAusd
  // (checkout.quote.ausdAmount) is what executeCheckout() actually debits.
  // A real bug lived here before this pass — the "Pay" button showed
  // DEMO_AMOUNT_USD (the merchant's local price) while the real charge is
  // DEMO_AMOUNT_USD + fee, understating what the user was agreeing to by
  // the fee amount. Fixed by showing the real total everywhere, not just
  // adding an itemized breakdown on top of the wrong number.
  const [feeAusd, setFeeAusd] = useState<number | undefined>(undefined);
  const [totalAusd, setTotalAusd] = useState<number | undefined>(undefined);
  const [doneTxHash, setDoneTxHash] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const expiryLabel = useCountdown(expiresAt);

  useEffect(() => {
    void requestQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestQuote() {
    if (!DEMO_MERCHANT_ADDRESS) {
      setError("VITE_DEMO_MERCHANT_ADDRESS isn't configured — set it in frontend/.env.");
      setStage("error");
      return;
    }
    setStage("loading");
    setError(undefined);
    try {
      const result = await endpoints.createCheckoutQuote({
        userId,
        merchantAddress: DEMO_MERCHANT_ADDRESS as Hex,
        localAmount: DEMO_AMOUNT_USD,
        localCurrency: "USD",
      });
      if (result.outcome === "INSUFFICIENT_BALANCE") {
        setStage("insufficient");
        return;
      }
      setCheckoutId(result.checkout.id);
      setPolicyId(result.policyId);
      setAgentQuorumId(result.agentQuorumId);
      setExpiresAt(result.checkout.quote.expiresAt);
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
      // The real owner-signed "Approve payment" tap (Section A.4 step 8) —
      // a fresh, live authorization for this exact merchant + amount, not a
      // durable grant like a recurring obligation's.
      await addSigners({ address: walletAddress, signers: [{ signerId: agentQuorumId, policyIds: [policyId] }] });
      const result = await endpoints.executeCheckout(checkoutId);
      if (result.outcome === "SETTLED") {
        setDoneTxHash(result.txHash);
        await refresh();
        setStage("done");
      } else if (result.outcome === "PENDING_CONFIRMATION") {
        setDoneTxHash(result.txHash);
        setStage("done"); // broadcast; treat as done for the demo, real fate resolves on-chain
      } else {
        setError(result.reason);
        setStage("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function reset() {
    setCheckoutId(undefined);
    setPolicyId(undefined);
    setAgentQuorumId(undefined);
    setDoneTxHash(undefined);
    void requestQuote();
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
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 24 }}>Checkout</h1>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26, textAlign: "center" }}>
        {stage === "loading" && <div style={{ padding: "30px 0", color: theme.inkMuted, fontSize: 14 }}>Checking rate, fee, and limits…</div>}

        {stage === "insufficient" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>Not enough balance for this purchase.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>Add funds to your wallet and try again.</p>
          </div>
        )}

        {stage === "error" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 14, color: theme.warn, fontWeight: 600 }}>Something went wrong.</div>
            <p style={{ marginTop: 8, fontSize: 13.5, color: theme.inkMuted }}>{error}</p>
            <button
              onClick={reset}
              style={{ marginTop: 16, padding: "10px 16px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        )}

        {stage === "review" && totalAusd !== undefined && feeAusd !== undefined && (
          <>
            <div style={{ fontSize: 13, color: theme.inkMuted, marginBottom: 8 }}>Paying</div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{DEMO_MERCHANT_NAME}</div>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 34, fontWeight: 600, marginTop: 16 }}>{formatUsd(totalAusd)}</div>
            <div style={{ fontSize: 12, color: theme.warn, marginTop: 6 }}>Quote expires in {expiryLabel}</div>

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${theme.border}`, textAlign: "left" }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 10 }}>
                Payment summary
              </div>
              <SummaryRow theme={theme} label="Item" value={formatUsd(DEMO_AMOUNT_USD)} />
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
            {/* Connects this one exact approval to the whole trust
                architecture — the same thing QuoteView/Explain already
                establish for recurring payments, now said plainly here
                too. */}
            <div style={{ marginTop: 10, fontSize: 11.5, color: theme.inkMuted }}>🔒 You are approving this exact amount, once.</div>
          </>
        )}

        {stage === "processing" && (
          <div style={{ padding: "30px 0" }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${theme.border}`, borderTopColor: theme.accent, borderRadius: "50%", margin: "0 auto", animation: "spin360 0.8s linear infinite" }} />
            <div style={{ marginTop: 16, fontSize: 14, color: theme.inkMuted }}>Sending payment…</div>
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
            <p style={{ marginTop: 6, fontSize: 13.5, color: theme.inkMuted }}>
              {totalAusd !== undefined ? formatUsd(totalAusd) : formatUsd(DEMO_AMOUNT_USD)} sent to {DEMO_MERCHANT_NAME}.
            </p>
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
                    <a
                      href={explorerTxUrl(doneTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: theme.accent, fontSize: 12, fontWeight: 600, textDecoration: "none" }}
                    >
                      View on explorer →
                    </a>
                  </div>
                </div>
              </div>
            )}
            <button
              onClick={reset}
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
