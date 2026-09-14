import { useEffect, useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { useCountdown } from "../../app/useCountdown";
import { formatUsd } from "../../app/format";
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
  const [fee, setFee] = useState<string | undefined>(undefined);
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
      setFee(formatUsd(Number(result.checkout.quote.feeAgentAusd) + Number(result.checkout.quote.feeNetworkAusd)));
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
        await refresh();
        setStage("done");
      } else if (result.outcome === "PENDING_CONFIRMATION") {
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
    void requestQuote();
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

        {stage === "review" && (
          <>
            <div style={{ fontSize: 13, color: theme.inkMuted, marginBottom: 8 }}>Paying</div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{DEMO_MERCHANT_NAME}</div>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 34, fontWeight: 600, marginTop: 16 }}>{formatUsd(DEMO_AMOUNT_USD)}</div>
            <div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 6 }}>
              Fee: {fee} · Quote expires in {expiryLabel}
            </div>
            <div style={{ fontSize: 11, color: theme.inkMuted, marginTop: 4 }}>Settled in AUSD (Agora) on Monad</div>
            <button
              onClick={handlePay}
              style={{ marginTop: 24, width: "100%", padding: 14, background: theme.accent, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 15, cursor: "pointer" }}
            >
              Pay {formatUsd(DEMO_AMOUNT_USD)}
            </button>
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
              {formatUsd(DEMO_AMOUNT_USD)} sent to {DEMO_MERCHANT_NAME}.
            </p>
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
