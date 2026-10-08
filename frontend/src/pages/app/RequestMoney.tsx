import { useState } from "react";
import { toDataURL } from "qrcode";
import { useAppTheme } from "../../app/ThemeContext";
import { useAppData } from "../../app/AppDataContext";
import { COUNTRY_OPTIONS } from "../../app/countries";
import { paymentRequestPayUrl } from "../../app/paymentRequestLink";
import { formatLocalAmount } from "../../app/format";
import * as endpoints from "../../api/endpoints";

type Stage = "form" | "submitting" | "ready";

/**
 * The REQUESTER side of the P2P flow — generates a QR/link asking to be
 * paid a specific amount. Deliberately asks nothing about WHO will pay:
 * that's resolved later, when someone opens the link (PayRequest.tsx) and
 * their own balance/FX gets checked at that moment (http/routes/
 * paymentRequests.ts's /pay step) — this screen only ever creates the
 * lightweight request record itself.
 */
export function RequestMoney() {
  const { theme } = useAppTheme();
  const { userId, refresh } = useAppData();

  const [stage, setStage] = useState<Stage>("form");
  const [amount, setAmount] = useState("");
  const [country, setCountry] = useState(COUNTRY_OPTIONS[0]!.name);
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>(undefined);
  const [payUrl, setPayUrl] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const selectedCountry = COUNTRY_OPTIONS.find((c) => c.name === country) ?? COUNTRY_OPTIONS[0]!;
  const amountNumber = Number(amount);

  async function handleCreate() {
    setError(undefined);
    if (!amountNumber || amountNumber <= 0) return setError("Enter an amount greater than 0.");

    setStage("submitting");
    try {
      const { request } = await endpoints.createPaymentRequest(userId, {
        localAmount: amountNumber,
        localCurrency: selectedCountry.currency,
        memo: memo.trim() || undefined,
      });
      const url = paymentRequestPayUrl(request.id);
      setPayUrl(url);
      setQrDataUrl(await toDataURL(url, { margin: 1, width: 240 }));
      await refresh();
      setStage("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("form");
    }
  }

  async function copyLink() {
    if (!payUrl) return;
    try {
      await navigator.clipboard.writeText(payUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // link is still shown and selectable, so this is non-fatal.
    }
  }

  async function shareLink() {
    if (!payUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Taxis payment request", text: `Pay me ${formatLocalAmount(amountNumber, selectedCountry.currency)} on Taxis`, url: payUrl });
        return;
      } catch {
        // User cancelled the share sheet, or the browser rejected it —
        // fall through to copy instead rather than leaving them stuck.
      }
    }
    await copyLink();
  }

  function reset() {
    setStage("form");
    setAmount("");
    setMemo("");
    setQrDataUrl(undefined);
    setPayUrl(undefined);
    setError(undefined);
  }

  if (stage === "ready" && qrDataUrl && payUrl) {
    return (
      <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 420 }}>
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: theme.inkMuted, marginBottom: 4 }}>Requesting</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 30, fontWeight: 600 }}>{formatLocalAmount(amountNumber, selectedCountry.currency)}</div>
          {memo && <div style={{ marginTop: 4, fontSize: 13, color: theme.inkMuted }}>{memo}</div>}

          <img src={qrDataUrl} alt="Scan to pay" style={{ marginTop: 20, width: 200, height: 200, borderRadius: 4 }} />

          <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
            <button
              onClick={copyLink}
              style={{ flex: 1, padding: 12, border: `1px solid ${theme.border}`, borderRadius: 4, background: "transparent", color: theme.ink, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              onClick={shareLink}
              style={{ flex: 1, padding: 12, border: "none", borderRadius: 4, background: theme.accent, color: "#fff", fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
            >
              Share
            </button>
          </div>

          <div style={{ marginTop: 14, fontSize: 11.5, color: theme.inkMuted }}>Anyone with this link or QR can pay it once — no Taxis account needed to view it.</div>

          <button onClick={reset} style={{ marginTop: 18, background: "none", border: "none", color: theme.inkMuted, fontSize: 13, cursor: "pointer" }}>
            ← Request something else
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 420 }}>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 26 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>Amount</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            style={{ padding: "10px 12px", border: `1px solid ${theme.border}`, borderRadius: 4, background: "transparent", color: theme.ink, fontSize: 18, fontFamily: "'JetBrains Mono',monospace" }}
          />
        </label>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, marginBottom: 8 }}>Currency</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {COUNTRY_OPTIONS.map((c) => (
              <button
                key={c.name}
                onClick={() => setCountry(c.name)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 14,
                  border: `1px solid ${c.name === country ? theme.accent : theme.border}`,
                  background: c.name === country ? theme.accent : "transparent",
                  color: c.name === country ? "#fff" : theme.ink,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {c.currency}
              </button>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted }}>What's it for? (optional)</span>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Lunch split"
            style={{ padding: "10px 12px", border: `1px solid ${theme.border}`, borderRadius: 4, background: "transparent", color: theme.ink, fontSize: 14 }}
          />
        </label>

        {error && <p style={{ marginBottom: 14, fontSize: 13, color: theme.warn }}>{error}</p>}
        <button
          onClick={handleCreate}
          disabled={stage === "submitting"}
          style={{ width: "100%", padding: 14, background: theme.accent, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 15, cursor: stage === "submitting" ? "default" : "pointer", opacity: stage === "submitting" ? 0.6 : 1 }}
        >
          {stage === "submitting" ? "Creating…" : "Generate QR / link"}
        </button>
      </div>
    </div>
  );
}
