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
      {/*
        html5-qrcode renders its own permission/camera-picker/file-upload UI
        with hardcoded English strings ("Request Camera Permissions", "Scan
        an Image File") that aren't overridable through its public API — but
        every interactive element it creates DOES carry a stable, documented
        hook for exactly this (confirmed from its own source,
        ui/scanner/base.js's PublicUiElementIdAndClasses): every button/
        select gets the class "html5-qrcode-element", so they can all be
        rethemed at once without touching private internals. The one
        non-public element retheme'd below (the small library-credit "i"
        icon, no id/class of its own) is targeted by its alt text instead —
        low risk since hiding a branding icon can't break scanning if that
        attribute ever changes, unlike relying on the library's internal ids.
      */}
      <style>{`
        #${SCANNER_ELEMENT_ID} { border: 1px solid ${theme.border} !important; border-radius: 6px !important; background: ${theme.surface}; overflow: hidden; }
        #${SCANNER_ELEMENT_ID} img[alt="Info icon"] { display: none !important; }
        #${SCANNER_ELEMENT_ID} .html5-qrcode-element {
          font-family: inherit !important;
          font-size: 13.5px !important;
          font-weight: 600 !important;
          padding: 10px 16px !important;
          border-radius: 4px !important;
          border: 1px solid ${theme.border} !important;
          background: ${theme.accent} !important;
          color: #fff !important;
          cursor: pointer;
        }
      `}</style>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Scan a Taxis payment QR</div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: theme.inkMuted }}>Point your camera at the payment QR code</div>
      </div>
      <div style={{ padding: 18 }}>
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
