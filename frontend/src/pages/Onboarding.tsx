import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { darkTheme, lightTheme } from "../theme/theme";
import { useAppTheme } from "../app/ThemeContext";
import { syncUser } from "../api/client";

/**
 * Real login, not the design's mock 4-step wizard (progress.md: "replacing
 * the mock DCLogic state with real client-side Privy login is exactly the
 * right sequencing, since that login is what makes ownership real for the
 * first time"). The original design's steps 1-2 (funding suggestion, a
 * hardcoded "Chinedu / Nigeria" first-payment preview) show data that
 * doesn't exist until a real recipient/obligation is created — carrying
 * those over here would just be re-mocking, not "faithfully building the
 * design." So this keeps the exact visual chrome of the design's step 0
 * and final success state, with a 2-segment step indicator, and drops the
 * illustrative middle steps until New Payment (a later screen) makes them
 * real.
 *
 * **Two real bugs, found from an actual browser click-through, both fixed
 * by leaning on `useLogin`'s own `onComplete` signal instead of hand-rolled
 * state:**
 *
 * 1. Sync used to run only from a `useEffect` guessing at auth state. Privy
 *    persists sessions across reloads, so a returning user landed here
 *    already `authenticated`, and the old code's disabled button (`disabled
 *    ={syncing || authenticated}`) just sat there doing nothing on click —
 *    stuck with no way forward.
 * 2. Even after that first fix, a returning already-authenticated visitor
 *    still had to sit through the full "Let's set you up" wizard chrome and
 *    manually tap "Go to dashboard" on a confirmation screen — exactly the
 *    "why do I have to log in again" complaint this component exists to
 *    avoid for a genuinely fresh signup, but wrong for someone who already
 *    has an account.
 *
 * The fix for both: Privy's `onComplete` callback already tells you which
 * case you're in via `wasAlreadyAuthenticated` — true the moment the hook
 * notices an existing valid session (no click needed), false only when this
 * page's own "Continue with passkey" tap just completed a fresh login. That
 * single flag now drives everything: a returning visitor gets a brief
 * "taking you to your dashboard" beat and a silent redirect into /app; a
 * fresh signup gets the full wizard and its confirmation moment. Landing.tsx
 * also now routes an already-logged-in visitor straight to /app and never
 * sends them here at all — this remains the fallback for anyone who lands
 * on /onboarding directly (a stale bookmark, browser back, a shared link).
 */
export function Onboarding() {
  const { dark, toggleTheme } = useAppTheme();
  const { ready, authenticated, user } = usePrivy();
  const [phase, setPhase] = useState<"authenticating" | "syncing" | "synced" | "error">("authenticating");
  const [skipWizard, setSkipWizard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const theme = dark ? darkTheme : lightTheme;

  async function runSync(userId: string, skip: boolean) {
    setPhase("syncing");
    setError(null);
    try {
      await syncUser(userId);
      setPhase("synced");
      if (skip) navigate("/app", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  const { login } = useLogin({
    onComplete: ({ user: completedUser, wasAlreadyAuthenticated }) => {
      setSkipWizard(wasAlreadyAuthenticated);
      void runSync(completedUser.id, wasAlreadyAuthenticated);
    },
    onError: (err) => setError(String(err)),
  });

  function retry() {
    if (!user) return;
    void runSync(user.id, skipWizard);
  }

  // Privy still hydrating its stored session — render nothing rather than
  // risk a flash of the wrong UI for someone who turns out to be logged in.
  if (!ready) {
    return <div style={{ background: theme.bg, minHeight: "100vh" }} />;
  }

  // Returning, already-authenticated visitor — skip the wizard entirely.
  if (skipWizard && (phase === "syncing" || phase === "error")) {
    return (
      <div style={{ background: theme.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: theme.ink, fontSize: 14 }}>
        {phase === "error" ? (
          <div style={{ textAlign: "center" }}>
            <p style={{ color: theme.warn, marginBottom: 14 }}>Couldn't load your account: {error}</p>
            <button
              onClick={retry}
              style={{ padding: "10px 18px", background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        ) : (
          <span style={{ color: theme.inkMuted }}>Taking you to your dashboard…</span>
        )}
      </div>
    );
  }

  const synced = phase === "synced";
  const syncing = phase === "syncing";
  const step = synced ? 1 : 0;

  return (
    <div style={{ background: theme.bg, minHeight: "100vh", fontSize: 15, color: theme.ink, transition: "background 0.3s" }}>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative" }}>
        <button
          onClick={toggleTheme}
          style={{
            position: "absolute",
            top: 24,
            right: 24,
            width: 38,
            height: 38,
            borderRadius: "50%",
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            color: theme.ink,
            cursor: "pointer",
          }}
        >
          {dark ? "☾" : "☀"}
        </button>

        <div
          style={{
            width: "100%",
            maxWidth: 440,
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            padding: 40,
            animation: "fadeUp 0.5s ease both",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
            <div style={{ width: 18, height: 18, background: theme.accent, transform: "rotate(45deg)", borderRadius: 3 }} />
            <span style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 17 }}>Taxis</span>
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? theme.accent : theme.border }} />
            ))}
          </div>

          {!synced ? (
            <>
              <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 24, letterSpacing: "-0.01em" }}>Let's set you up</h1>
              <p style={{ marginTop: 10, fontSize: 14.5, color: theme.inkMuted, lineHeight: 1.55 }}>
                No passwords, no seed phrase. We'll create your account and secure it to your device.
              </p>
              {authenticated ? (
                // Fresh login just completed, sync still in flight — not
                // the returning-visitor case (that's handled above).
                <div style={{ marginTop: 28, textAlign: "center", fontSize: 14, color: theme.inkMuted }}>
                  {syncing || !error ? "Setting up your wallet…" : "Couldn't finish setting up your wallet."}
                </div>
              ) : (
                <button
                  onClick={() => login()}
                  style={{
                    marginTop: 28,
                    width: "100%",
                    padding: 14,
                    background: theme.ink,
                    color: theme.bg,
                    border: "none",
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 15,
                    cursor: "pointer",
                  }}
                >
                  Continue with passkey
                </button>
              )}
              {error && (
                <>
                  <p style={{ marginTop: 14, fontSize: 13, color: theme.warn }}>
                    Something went wrong: {error}
                  </p>
                  {authenticated && (
                    <button
                      onClick={retry}
                      style={{
                        marginTop: 10,
                        width: "100%",
                        padding: 12,
                        background: "none",
                        border: `1px solid ${theme.border}`,
                        color: theme.ink,
                        borderRadius: 4,
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Retry
                    </button>
                  )}
                </>
              )}
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
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
              <h1 style={{ marginTop: 20, fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 22 }}>You're set up</h1>
              <p style={{ marginTop: 8, fontSize: 14.5, color: theme.inkMuted }}>
                Taxis will check in every cycle and show you the receipt.
              </p>
              <button
                onClick={() => navigate("/app")}
                style={{
                  marginTop: 24,
                  width: "100%",
                  padding: 14,
                  background: theme.ink,
                  color: theme.bg,
                  border: "none",
                  borderRadius: 4,
                  fontWeight: 600,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                Go to dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
