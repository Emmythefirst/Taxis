import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Html5QrcodeScanner } from "html5-qrcode";
import { useAppTheme } from "../../app/ThemeContext";
import { parsePaymentRequestId } from "../../app/paymentRequestLink";

const SCANNER_ELEMENT_ID = "taxis-qr-scanner";

/**
 * The PAYER's entry point for scanning someone else's request QR. A plain
 * tapped link (no camera at all) reaches the exact same destination —
 * /app/pay/:requestId — this is just the camera-based convenience for the
 * in-person case. html5-qrcode's Html5QrcodeScanner renders its own
 * permission/camera-picker UI into the target div; we only own the
 * container and the success callback.
 */
export function ScanToPay() {
  const { theme } = useAppTheme();
  const navigate = useNavigate();
  const [manualInput, setManualInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const scannerRef = useRef<Html5QrcodeScanner | undefined>(undefined);
  const navigatedRef = useRef(false);

  useEffect(() => {
    const scanner = new Html5QrcodeScanner(SCANNER_ELEMENT_ID, { fps: 10, qrbox: 230 }, false);
    scannerRef.current = scanner;
    scanner.render(
      (decodedText) => {
        if (navigatedRef.current) return;
        const requestId = parsePaymentRequestId(decodedText);
        if (!requestId) {
          setError("That QR doesn't look like a Taxis payment request.");
          return;
        }
        navigatedRef.current = true;
        void scanner.clear();
        navigate(`/app/pay/${requestId}`);
      },
      () => {
        // Per-frame "nothing decoded yet" callback — expected continuously
        // while the camera is pointed at anything that isn't a QR code, not
        // a real error worth surfacing.
      },
    );

    return () => {
      void scannerRef.current?.clear().catch(() => {
        // Already cleared/torn down — nothing to do.
      });
    };
  }, [navigate]);

  function handleManualSubmit() {
    setError(undefined);
    const requestId = parsePaymentRequestId(manualInput);
    if (!requestId) {
      setError("Paste a Taxis payment link, or the request id directly.");
      return;
    }
    navigate(`/app/pay/${requestId}`);
  }

  return (
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 420 }}>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 18 }}>
        <div id={SCANNER_ELEMENT_ID} />
      </div>

      <div style={{ marginTop: 18, fontSize: 12.5, color: theme.inkMuted, textAlign: "center" }}>— or —</div>

      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <input
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="Paste a payment link"
          style={{ flex: 1, padding: "10px 12px", border: `1px solid ${theme.border}`, borderRadius: 4, background: "transparent", color: theme.ink, fontSize: 13.5 }}
        />
        <button
          onClick={handleManualSubmit}
          style={{ padding: "10px 16px", border: "none", borderRadius: 4, background: theme.accent, color: "#fff", fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
        >
          Go
        </button>
      </div>

      {error && <p style={{ marginTop: 12, fontSize: 13, color: theme.warn }}>{error}</p>}
    </div>
  );
}
