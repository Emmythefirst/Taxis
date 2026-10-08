import { useState } from "react";
import { useAppTheme } from "../../app/ThemeContext";
import { RequestMoney } from "./RequestMoney";
import { ScanToPay } from "./ScanToPay";

type Mode = "request" | "scan";

export function PayHub() {
  const { theme } = useAppTheme();
  const [mode, setMode] = useState<Mode>("request");

  return (
    <div style={{ animation: "fadeUp 0.4s ease both" }}>
      <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.01em", marginBottom: 24 }}>Pay</h1>

      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        <button
          onClick={() => setMode("request")}
          style={{
            padding: "8px 16px",
            borderRadius: 16,
            border: `1px solid ${mode === "request" ? theme.accent : theme.border}`,
            background: mode === "request" ? theme.accent : "transparent",
            color: mode === "request" ? "#fff" : theme.ink,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Request money
        </button>
        <button
          onClick={() => setMode("scan")}
          style={{
            padding: "8px 16px",
            borderRadius: 16,
            border: `1px solid ${mode === "scan" ? theme.accent : theme.border}`,
            background: mode === "scan" ? theme.accent : "transparent",
            color: mode === "scan" ? "#fff" : theme.ink,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Scan to pay
        </button>
      </div>

      {mode === "request" ? <RequestMoney /> : <ScanToPay />}
    </div>
  );
}
