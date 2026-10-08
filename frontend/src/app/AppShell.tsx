import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { useAppTheme } from "./ThemeContext";
import { AppDataProvider, useAppData } from "./AppDataContext";

const NAV_ITEMS = [
  { to: "/app", glyph: "⌂", label: "Home", end: true },
  { to: "/app/payments", glyph: "↻", label: "Payments", end: false },
  { to: "/app/activity", glyph: "≡", label: "Activity", end: false },
  { to: "/app/checkout", glyph: "⊙", label: "Checkout", end: false },
  { to: "/app/settings", glyph: "⚙", label: "Settings", end: false },
];

function Sidebar() {
  const { theme } = useAppTheme();
  const { balance, walletAddress } = useAppData();
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // address is still shown and selectable, so this is non-fatal.
    }
  }

  return (
    <aside
      style={{
        borderRight: `1px solid ${theme.border}`,
        padding: "24px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 28,
        background: theme.surface,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 8px" }}>
        <div style={{ width: 16, height: 16, background: theme.accent, transform: "rotate(45deg)", borderRadius: 3 }} />
        <span style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 16 }}>Taxis</span>
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "10px 12px",
              borderRadius: 4,
              background: isActive ? theme.bgAlt : "transparent",
              color: isActive ? theme.ink : theme.inkMuted,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
            })}
          >
            <span style={{ fontSize: 15, width: 16 }}>{item.glyph}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ padding: 12, background: theme.bgAlt, borderRadius: 4 }}>
          <div style={{ fontSize: 11.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Available</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, fontSize: 16, marginTop: 2 }}>
            {balance !== undefined ? `$${balance}` : "—"}
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: theme.inkMuted, padding: "0 4px", lineHeight: 1.4 }}>⛓ Scheduled by Chainlink CRE</div>
        {walletAddress && (
          <div style={{ padding: 10, border: `1px solid ${theme.border}`, borderRadius: 4 }}>
            <div style={{ fontSize: 10.5, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 5 }}>Your wallet</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5 }}>
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
              </span>
              <button
                onClick={copyAddress}
                style={{ background: "none", border: "none", color: theme.inkMuted, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0, flexShrink: 0 }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function AppShellInner() {
  const { theme, dark, toggleTheme } = useAppTheme();
  const { loading, error } = useAppData();

  return (
    <div style={{ background: theme.bg, minHeight: "100vh", color: theme.ink, fontSize: 15 }}>
      <button
        onClick={() => toggleTheme()}
        aria-label="Toggle theme"
        style={{
          position: "fixed",
          top: 24,
          right: 24,
          width: 38,
          height: 38,
          borderRadius: "50%",
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          color: theme.ink,
          fontSize: 16,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10,
        }}
      >
        {dark ? "☾" : "☀"}
      </button>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
        <Sidebar />
        <main style={{ padding: "36px 44px", maxWidth: 980 }}>
          {error && (
            <div style={{ marginBottom: 20, padding: 14, background: theme.bgAlt, borderRadius: 4, color: theme.warn, fontSize: 13.5 }}>
              Couldn't load your data: {error}
            </div>
          )}
          {loading ? <div style={{ color: theme.inkMuted, fontSize: 14 }}>Loading…</div> : <Outlet />}
        </main>
      </div>
    </div>
  );
}

export function AppShell() {
  const { ready, authenticated } = usePrivy();
  const navigate = useNavigate();

  useEffect(() => {
    if (ready && !authenticated) navigate("/onboarding", { replace: true });
  }, [ready, authenticated, navigate]);

  if (!ready || !authenticated) return null;

  return (
    <AppDataProvider>
      <AppShellInner />
    </AppDataProvider>
  );
}
