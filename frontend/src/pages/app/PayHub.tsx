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

      <div style={{ display: "inline-flex", padding: 3, background: theme.bgAlt, borderRadius: 10, marginBottom: 20 }}>
        {(["request", "scan"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: "8px 18px",
              borderRadius: 7,
              border: "none",
              background: mode === m ? theme.surface : "transparent",
              color: mode === m ? theme.ink : theme.inkMuted,
              boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease",
            }}
          >
            {m === "request" ? "Request money" : "Scan to pay"}
          </button>
        ))}
      </div>

      {mode === "request" ? <RequestMoney /> : <ScanToPay />}
    </div>
  );
}
