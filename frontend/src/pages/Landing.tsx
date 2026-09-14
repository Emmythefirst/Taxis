import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { darkLandingTheme, lightLandingTheme, type LandingTheme } from "../theme/theme";
import { useAppTheme } from "../app/ThemeContext";

/**
 * Public marketing page (progress.md's decoded landing/template.html) —
 * static content, faithfully reproduced, with deviations noted where they
 * occur: a real ticking countdown loop instead of a fixed number, and every
 * "Get early access" CTA replaced with a real link into the working app.
 * The original design's only CTAs were a fake email waitlist form — for a
 * hackathon submission that's a live, working product, sending a judge into
 * a dead-end form instead of the actual app is the wrong default, so the
 * waitlist was dropped entirely rather than kept alongside a real path.
 */

const PAID_CHECKS = [
  "Payment was due today",
  "Recipient is authorized",
  "Rate was within your tolerance",
  "Fee was below your limit",
  "Monthly spending limit not exceeded",
  "Balance was sufficient",
  "Quote had time remaining before expiry",
];

const FEATURES = [
  { glyph: "↻", title: "Recurring payments, anywhere", desc: "Pay someone in another country every month without redoing the setup." },
  { glyph: "▦", title: "Limits that actually hold", desc: "Your cap and rate tolerance aren't a suggestion. Outside them, it waits for you." },
  { glyph: "≡", title: "A receipt, every time", desc: "See exactly why a payment went through, or why it didn't, in plain language." },
  { glyph: "⊙", title: "Merchant checkout", desc: "Use the same balance to pay for things directly. No separate wallet to juggle." },
  { glyph: "↪", title: "Backup recipient", desc: "Go quiet for a while and payments can redirect to someone you chose ahead of time." },
  { glyph: "✕", title: "One-tap stop", desc: "Cut off Taxis's access instantly, anytime. No waiting, no support ticket." },
];

// Named explicitly, not just "digital dollars"/"automated" — Agora and
// Chainlink CRE need to be clearly visible for judging (Section A.14), not
// just implemented invisibly underneath generic marketing copy.
const BADGES = ["SETTLED IN AUSD VIA AGORA", "AUTOMATED BY CHAINLINK CRE", "NON-CUSTODIAL BY DESIGN", "BUILT ON MONAD", "SIGNED QUOTES, EVERY CYCLE", "REVOCABLE, ANYTIME"];

const FAQS = [
  { question: "Is this a crypto wallet?", answer: "No — it's a payments app. There's a digital-dollar balance underneath, but it's invisible plumbing: no seed phrases, no addresses to copy, nothing that feels like crypto." },
  { question: "What if the rate or fee changes before a payment goes out?", answer: "Taxis re-checks it fresh every cycle, right before it pays. If it's outside what you set, the payment pauses and asks you first — it never guesses on your behalf." },
  { question: "What happens if I go quiet for a while?", answer: "You choose a backup recipient in advance. If you don't check in for a period you set, scheduled payments redirect there instead of stalling." },
  { question: "Can I stop it anytime?", answer: "Yes, instantly. One tap revokes Taxis's permission entirely. Your account and balance stay exactly where they are — untouched." },
  { question: "Where does my money actually sit?", answer: "In your own account the whole time. Taxis never takes custody — it only holds a narrow, revocable permission to pay within the rules you set." },
];

function useDemoCountdown(): string {
  const [seconds, setSeconds] = useState(292);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => (s <= 0 ? 300 : s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Landing() {
  const { dark, toggleTheme } = useAppTheme();
  const [demoTab, setDemoTab] = useState<0 | 1>(0);
  const [faqOpen, setFaqOpen] = useState<boolean[]>(FAQS.map(() => false));
  const navigate = useNavigate();
  const expiryLabel = useDemoCountdown();
  // A visitor who's already logged in (Privy's session persists across
  // reloads/tabs) should never be routed back through the onboarding
  // wizard — that's the exact "why do I have to log in again" complaint.
  // Every entry point below reflects actual auth state instead of always
  // assuming "logged out."
  const { ready, authenticated } = usePrivy();
  const entryPath = ready && authenticated ? "/app" : "/onboarding";
  const entryLabel = ready && authenticated ? "Go to dashboard" : "Log in / Sign up";

  const theme = dark ? darkLandingTheme : lightLandingTheme;

  function toggleFaq(idx: number) {
    setFaqOpen((prev) => prev.map((v, i) => (i === idx ? !v : v)));
  }

  return (
    <div style={{ background: theme.bg, minHeight: "100vh", position: "relative", overflowX: "hidden", transition: "background 0.3s" }}>
      <div style={{ position: "fixed", top: "-10%", left: "-8%", width: 520, height: 520, borderRadius: "50%", background: theme.blob1, filter: "blur(70px)", opacity: 0.5, animation: "drift1 22s ease-in-out infinite", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "fixed", bottom: "-15%", right: "-10%", width: 600, height: 600, borderRadius: "50%", background: theme.blob2, filter: "blur(80px)", opacity: 0.45, animation: "drift2 26s ease-in-out infinite", pointerEvents: "none", zIndex: 0 }} />

      <header style={{ position: "sticky", top: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 6vw", backdropFilter: "blur(14px)", background: theme.headerBg, borderBottom: `1px solid ${theme.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 20, height: 20, background: theme.accent, transform: "rotate(45deg)", borderRadius: 3 }} />
          <span style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-0.02em", color: theme.ink }}>Taxis</span>
        </div>
        <nav style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <a href="#how" style={{ fontSize: 15, fontWeight: 500, color: theme.inkMuted }}>How it works</a>
          <a href="#trust" style={{ fontSize: 15, fontWeight: 500, color: theme.inkMuted }}>Trust layer</a>
          <a href="#faq" style={{ fontSize: 15, fontWeight: 500, color: theme.inkMuted }}>FAQ</a>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={() => toggleTheme()} aria-label="Toggle theme" style={{ width: 38, height: 38, borderRadius: "50%", border: `1px solid ${theme.border}`, background: theme.surface, color: theme.ink, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {dark ? "☾" : "☀"}
          </button>
          <button onClick={() => navigate(entryPath)} style={{ padding: "11px 20px", background: theme.ink, color: theme.bg, fontSize: 14, fontWeight: 600, borderRadius: 3, border: "none", cursor: "pointer" }}>
            {entryLabel}
          </button>
        </div>
      </header>

      <section style={{ position: "relative", zIndex: 1, maxWidth: 1240, margin: "0 auto", padding: "96px 6vw 80px", display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 56, alignItems: "center" }}>
        <div style={{ animation: "fadeUp 0.8s ease both" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", border: `1px solid ${theme.border}`, borderRadius: 20, fontSize: 12.5, fontWeight: 600, color: theme.inkMuted, marginBottom: 28, letterSpacing: "0.02em" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: theme.success, animation: "pulseDot 1.8s ease-in-out infinite" }} />
            BUILT FOR MONAD METROPOLIS · PRIVATE BETA
          </div>
          <h1 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(38px,5.2vw,64px)", lineHeight: 1.04, letterSpacing: "-0.02em", color: theme.ink }}>
            Money you send every month, run by an agent that shows its work.
          </h1>
          <p style={{ marginTop: 24, fontSize: 18, lineHeight: 1.6, color: theme.inkMuted, maxWidth: 520 }}>
            Set up a payment once. Taxis checks the rate, the fee, and your rules every time it's due — and hands you the receipt before anything moves, not after.
          </p>
          <div style={{ display: "flex", gap: 14, marginTop: 36, flexWrap: "wrap" }}>
            <button onClick={() => navigate(entryPath)} style={{ padding: "15px 26px", background: theme.accent, color: theme.accentInk, fontWeight: 600, fontSize: 15.5, borderRadius: 3, border: "none", cursor: "pointer" }}>{ready && authenticated ? "Go to dashboard" : "Get started"}</button>
            <a href="#how" style={{ padding: "15px 26px", border: `1px solid ${theme.border}`, color: theme.ink, fontWeight: 600, fontSize: 15.5, borderRadius: 3 }}>See how it works</a>
          </div>
          <div style={{ display: "flex", gap: 32, marginTop: 52 }}>
            <div><div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 600, color: theme.ink }}>0</div><div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 4 }}>silent skips ever</div></div>
            <div><div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 600, color: theme.ink }}>3</div><div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 4 }}>gates checked per cycle</div></div>
            <div><div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 600, color: theme.ink }}>1 tap</div><div style={{ fontSize: 12.5, color: theme.inkMuted, marginTop: 4 }}>to stop it, anytime</div></div>
          </div>
        </div>

        <div style={{ position: "relative", animation: "fadeUp 0.9s ease 0.15s both" }}>
          <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, boxShadow: `0 30px 60px -20px ${theme.shadow}`, padding: 26, maxWidth: 400, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>Payment quote</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: theme.success }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: theme.success, animation: "pulseDot 1.6s ease-in-out infinite" }} />LIVE
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <QuoteRow theme={theme} label="To" value="Chinedu · Lagos" delay={0.3} />
              <QuoteRow theme={theme} label="They get" value="₦300,000" mono delay={0.55} />
              <QuoteRow theme={theme} label="You send" value="$203.84" mono delay={0.8} />
              <QuoteRow theme={theme} label="Fee" value="$0.04" mono delay={1.05} />
              <QuoteRow theme={theme} label="Quote expires in" value={expiryLabel} mono color={theme.warn} delay={1.3} />
            </div>
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${theme.border}`, display: "flex", alignItems: "center", gap: 10, animation: "stampIn 0.6s ease 1.6s both" }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: theme.success, color: theme.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 }}>✓</div>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink }}>Signed and ready — nothing sent yet</span>
            </div>
          </div>
          <div style={{ position: "absolute", top: -16, right: "8%", width: 44, height: 44, border: `1px solid ${theme.border}`, borderRadius: "50%", opacity: 0.5, animation: "spin360 18s linear infinite" }} />
        </div>
      </section>

      <section id="how" style={{ position: "relative", zIndex: 1, maxWidth: 1240, margin: "0 auto", padding: "80px 6vw" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 48, flexWrap: "wrap", gap: 12 }}>
          <h2 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(28px,3.4vw,40px)", color: theme.ink, letterSpacing: "-0.01em" }}>How it works</h2>
          <span style={{ fontSize: 14, color: theme.inkMuted, maxWidth: 340 }}>Four steps, most of them one-time.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 1, background: theme.border, border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
          {[
            { n: "01", title: "Add who you pay", desc: "Recipient, amount, how often. No bank forms." },
            { n: "02", title: "Approve once", desc: "One tap sets your limit. No seed phrase, nothing to manage." },
            { n: "03", title: "Taxis checks in each cycle", desc: "Current rate, current fee, your rules — rechecked fresh, every time." },
            { n: "04", title: "You see the proof", desc: "Before it pays, and after. Nothing happens quietly." },
          ].map((step) => (
            <div key={step.n} style={{ background: theme.surface, padding: "32px 26px" }}>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: theme.accent, fontWeight: 600 }}>{step.n}</div>
              <h3 style={{ marginTop: 16, fontSize: 17, fontWeight: 700, color: theme.ink }}>{step.title}</h3>
              <p style={{ marginTop: 10, fontSize: 14.5, lineHeight: 1.55, color: theme.inkMuted }}>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="trust" style={{ position: "relative", zIndex: 1, background: theme.bgAlt, padding: "88px 6vw", borderTop: `1px solid ${theme.border}`, borderBottom: `1px solid ${theme.border}` }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 64, alignItems: "start" }}>
          <div>
            <h2 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(28px,3.4vw,40px)", color: theme.ink, letterSpacing: "-0.01em" }}>Before Taxis moves a cent, it writes the receipt first.</h2>
            <p style={{ marginTop: 20, fontSize: 16, lineHeight: 1.65, color: theme.inkMuted, maxWidth: 460 }}>
              Every payment is priced fresh — recipient, amount, fee, and a short expiry, bound together. If a payment ever falls outside the rules you set, it doesn't sneak through and it doesn't vanish. It waits, and it tells you exactly why.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 32 }}>
              {["Same rules checked every single cycle, not just at setup", "A quote expires in minutes — it can't be reused or replayed", "Outside your limits, it pauses for you — it never guesses"].map((line) => (
                <div key={line} style={{ display: "flex", gap: 12 }}>
                  <span style={{ color: theme.success, fontWeight: 700 }}>✓</span>
                  <span style={{ fontSize: 14.5, color: theme.ink }}>{line}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 8, boxShadow: `0 24px 50px -24px ${theme.shadow}` }}>
            <div style={{ display: "flex", gap: 8, padding: "10px 10px 0" }}>
              <button onClick={() => setDemoTab(0)} style={{ flex: 1, padding: 10, border: "none", borderRadius: 4, fontSize: 13.5, fontWeight: 600, cursor: "pointer", background: demoTab === 0 ? theme.bg : "transparent", color: demoTab === 0 ? theme.ink : theme.inkMuted }}>
                Went through
              </button>
              <button onClick={() => setDemoTab(1)} style={{ flex: 1, padding: 10, border: "none", borderRadius: 4, fontSize: 13.5, fontWeight: 600, cursor: "pointer", background: demoTab === 1 ? theme.bg : "transparent", color: demoTab === 1 ? theme.ink : theme.inkMuted }}>
                Paused for review
              </button>
            </div>
            {demoTab === 0 ? (
              <div style={{ padding: 26 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.inkMuted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 16 }}>Payment executed because</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {PAID_CHECKS.map((check) => (
                    <div key={check} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ color: theme.success, fontWeight: 700, fontSize: 14 }}>✓</span>
                      <span style={{ fontSize: 14.5, color: theme.ink }}>{check}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", fontSize: 13.5, color: theme.inkMuted }}>
                  <span>Sep 27 · 10:42 AM</span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: theme.ink }}>$203.84 sent</span>
                </div>
              </div>
            ) : (
              <div style={{ padding: 26 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.warn, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 16 }}>Payment paused — nothing was charged</div>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 20 }}>
                  <span style={{ color: theme.warn, fontWeight: 700 }}>⚠</span>
                  <span style={{ fontSize: 14.5, color: theme.ink, lineHeight: 1.5 }}>The current exchange rate would cost more than your limit allows.</span>
                </div>
                <div style={{ display: "flex", gap: 24 }}>
                  <div><div style={{ fontSize: 12.5, color: theme.inkMuted }}>Current cost</div><div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 19, fontWeight: 600, color: theme.warn, marginTop: 4 }}>$217.40</div></div>
                  <div><div style={{ fontSize: 12.5, color: theme.inkMuted }}>Your maximum</div><div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 19, fontWeight: 600, color: theme.ink, marginTop: 4 }}>$210.00</div></div>
                </div>
                <div style={{ marginTop: 22, paddingTop: 16, borderTop: `1px solid ${theme.border}` }}>
                  <button style={{ width: "100%", padding: 12, background: theme.ink, color: theme.bg, border: "none", borderRadius: 4, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Review and approve</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section style={{ position: "relative", zIndex: 1, maxWidth: 1240, margin: "0 auto", padding: "88px 6vw" }}>
        <div style={{ marginBottom: 48 }}>
          <h2 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(28px,3.4vw,40px)", color: theme.ink, letterSpacing: "-0.01em" }}>What you actually get</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 1, background: theme.border, border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ background: theme.surface, padding: "30px 26px" }}>
              <div style={{ width: 34, height: 34, borderRadius: 3, background: dark ? "rgba(91,117,255,0.18)" : "rgba(52,82,225,0.10)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{f.glyph}</div>
              <h3 style={{ marginTop: 18, fontSize: 16.5, fontWeight: 700, color: theme.ink }}>{f.title}</h3>
              <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: theme.inkMuted }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ position: "relative", zIndex: 1, padding: "36px 6vw", borderTop: `1px solid ${theme.border}`, borderBottom: `1px solid ${theme.border}`, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 64, width: "max-content", animation: "marqueeScroll 22s linear infinite" }}>
          {[...BADGES, ...BADGES].map((b, i) => (
            <span key={i} style={{ fontSize: 13.5, fontWeight: 600, color: theme.inkMuted, letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{b}</span>
          ))}
        </div>
      </section>

      <section id="faq" style={{ position: "relative", zIndex: 1, maxWidth: 820, margin: "0 auto", padding: "88px 6vw" }}>
        <h2 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(28px,3.4vw,40px)", color: theme.ink, letterSpacing: "-0.01em", marginBottom: 40 }}>Questions</h2>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {FAQS.map((q, i) => (
            <div key={q.question} style={{ borderBottom: `1px solid ${theme.border}` }}>
              <button onClick={() => toggleFaq(i)} style={{ width: "100%", textAlign: "left", padding: "20px 0", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: theme.ink }}>{q.question}</span>
                <span style={{ fontSize: 18, color: theme.inkMuted, flexShrink: 0 }}>{faqOpen[i] ? "–" : "+"}</span>
              </button>
              {faqOpen[i] && <p style={{ padding: "0 0 20px", fontSize: 14.5, lineHeight: 1.6, color: theme.inkMuted, maxWidth: 600 }}>{q.answer}</p>}
            </div>
          ))}
        </div>
      </section>

      <section style={{ position: "relative", zIndex: 1, margin: "0 6vw 88px", background: theme.ink, borderRadius: 8, padding: "72px 6vw", textAlign: "center", overflow: "hidden" }}>
        <h2 style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: "clamp(28px,4vw,44px)", color: theme.bg, letterSpacing: "-0.01em" }}>See it work, not just read about it.</h2>
        <p style={{ marginTop: 14, fontSize: 16, color: theme.inkDarkMuted, maxWidth: 440, marginLeft: "auto", marginRight: "auto" }}>This is the real thing, running on Monad testnet. No seed phrase, no forms — connect in seconds.</p>
        <div style={{ marginTop: 32 }}>
          <button onClick={() => navigate(entryPath)} style={{ padding: "15px 30px", background: theme.accent, color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: 15.5, cursor: "pointer" }}>
            {ready && authenticated ? "Go to dashboard" : "Get started"}
          </button>
        </div>
      </section>

      <footer style={{ position: "relative", zIndex: 1, maxWidth: 1240, margin: "0 auto", padding: "0 6vw 48px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 14, height: 14, background: theme.accent, transform: "rotate(45deg)", borderRadius: 2 }} />
          <span style={{ fontFamily: "'Unbounded',sans-serif", fontWeight: 700, fontSize: 14, color: theme.ink }}>Taxis</span>
        </div>
        <span style={{ fontSize: 13, color: theme.inkMuted }}>Built for Monad Metropolis — Consumer Products &amp; Payments track. Testnet demo, not a live money-transmission product.</span>
      </footer>
    </div>
  );
}

function QuoteRow({ theme, label, value, mono, color, delay }: { theme: LandingTheme; label: string; value: string; mono?: boolean; color?: string; delay: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", animation: `rowIn 0.5s ease ${delay}s both` }}>
      <span style={{ fontSize: 14, color: theme.inkMuted }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: color ?? theme.ink, fontFamily: mono ? "'JetBrains Mono',monospace" : undefined }}>{value}</span>
    </div>
  );
}
