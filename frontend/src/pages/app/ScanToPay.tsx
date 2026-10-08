import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Html5Qrcode } from "html5-qrcode";
import { useAppTheme } from "../../app/ThemeContext";
import { parsePaymentRequestId } from "../../app/paymentRequestLink";

const SCANNER_ELEMENT_ID = "taxis-qr-scanner";

type CameraState = "starting" | "scanning" | "unavailable";

/**
 * The PAYER's entry point for scanning someone else's request QR. A plain
 * tapped link (no camera at all) reaches the exact same destination —
 * /app/pay/:requestId — this is just the camera-based convenience for the
 * in-person case.
 *
 * Deliberately uses the low-level `Html5Qrcode` class rather than
 * `Html5QrcodeScanner` (the batteries-included widget used in the first
 * version of this screen): the widget renders its own "Request Camera
 * Permissions" button and makes you tap it before anything happens, which
 * read as an extra, dev-tool-looking step. The camera here starts itself —
 * `.start()` is called the moment this screen mounts, which is also what
 * triggers the browser's own native permission prompt the first time —  so
 * there's nothing to tap through before scanning. Uploading an image
 * instead stays available as a plain secondary link, not a competing
 * primary button, and only takes over the scan surface (stopping the live
 * camera first) when actually used.
 */
export function ScanToPay() {
  const { theme } = useAppTheme();
  const navigate = useNavigate();
  const [cameraState, setCameraState] = useState<CameraState>("starting");
  const [manualInput, setManualInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const qrRef = useRef<Html5Qrcode | undefined>(undefined);
  const navigatedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const qr = new Html5Qrcode(SCANNER_ELEMENT_ID, false);
    qrRef.current = qr;

    function onDecoded(decodedText: string) {
      if (navigatedRef.current) return;
      const requestId = parsePaymentRequestId(decodedText);
      if (!requestId) {
        setError("That QR doesn't look like a Taxis payment request.");
        return;
      }
      navigatedRef.current = true;
      void qr.stop().catch(() => {});
      navigate(`/app/pay/${requestId}`);
    }

    qr.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 230 },
      onDecoded,
      () => {
        // Per-frame "nothing decoded yet" callback — expected continuously
        // while the camera is pointed at anything that isn't a QR code.
      },
    )
      .then(() => setCameraState("scanning"))
      .catch(() => setCameraState("unavailable"));

    return () => {
      navigatedRef.current = true;
      if (qr.isScanning) {
        void qr.stop().then(() => qr.clear()).catch(() => qr.clear());
      } else {
        qr.clear();
      }
    };
  }, [navigate]);

  async function handleFileChosen(file: File | undefined) {
    if (!file || !qrRef.current) return;
    setError(undefined);
    const qr = qrRef.current;
    try {
      if (qr.isScanning) await qr.stop();
      const result = await qr.scanFileV2(file, false);
      const requestId = parsePaymentRequestId(result.decodedText);
      if (!requestId) {
        setError("Couldn't find a Taxis payment QR in that image.");
        return;
      }
      navigatedRef.current = true;
      navigate(`/app/pay/${requestId}`);
    } catch {
      setError("Couldn't find a QR code in that image.");
    }
  }

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
    <div style={{ animation: "fadeUp 0.4s ease both", maxWidth: 520 }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Scan a Taxis payment QR</div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: theme.inkMuted }}>
          {cameraState === "unavailable" ? "Camera access isn't available — upload an image instead." : "Point your camera at the payment QR code"}
        </div>
      </div>

      <div
        style={{
          position: "relative",
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          overflow: "hidden",
          minHeight: 260,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div id={SCANNER_ELEMENT_ID} style={{ width: "100%" }} />
        {cameraState === "starting" && <div style={{ position: "absolute", fontSize: 13, color: theme.inkMuted }}>Starting camera…</div>}
        {cameraState === "unavailable" && (
          <div style={{ position: "absolute", textAlign: "center", padding: "0 20px" }}>
            <div style={{ fontSize: 13, color: theme.inkMuted, marginBottom: 12 }}>Enable camera access in your browser, or upload a QR image below.</div>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: "10px 18px", border: `1px solid ${theme.border}`, borderRadius: 4, background: "transparent", color: theme.ink, fontWeight: 600, fontSize: 13.5, cursor: "pointer" }}
            >
              Upload QR image
            </button>
          </div>
        )}
      </div>

      {cameraState === "scanning" && (
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{ display: "block", margin: "12px auto 0", background: "none", border: "none", color: theme.inkMuted, fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}
        >
          Upload QR image instead
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => void handleFileChosen(e.target.files?.[0])}
      />

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

      {error && <p style={{ marginTop: 12, fontSize: 13, color: theme.warn, textAlign: "center" }}>{error}</p>}
    </div>
  );
}
