/**
 * Design tokens extracted from the validated Claude Design canvas
 * (progress.md's frontend build log) — colors, fonts, and the light/dark
 * theme objects, kept exactly as designed rather than reinterpreted.
 */

export interface Theme {
  bg: string;
  bgAlt: string;
  surface: string;
  ink: string;
  inkMuted: string;
  border: string;
  accent: string;
  success: string;
  warn: string;
  /**
   * Distinct from `warn` — scoped specifically to the status-pill system
   * (pillColors' "danger" kind), not a general app-wide error color.
   * `warn` already means two different things throughout the app
   * ("needs your decision," e.g. REQUIRES_APPROVAL — amber, actionable and
   * not actually bad news; and generic form/network error text). This adds
   * a third, specifically for a cycle/checkout that was actually attempted
   * and rejected (FAILED) — a concluded, adverse outcome, not a pending
   * one. See activityFeed.ts's cycleStatusPresentation().
   */
  danger: string;
}

export const lightTheme: Theme = {
  bg: "#F8F6F1",
  bgAlt: "#EFEBE2",
  surface: "#FFFFFF",
  ink: "#14151A",
  inkMuted: "#5B5C66",
  border: "rgba(20,21,26,0.12)",
  accent: "#3452E1",
  success: "#2F7A52",
  warn: "#B5451F",
  danger: "#C23B3B",
};

export const darkTheme: Theme = {
  bg: "#0B0D12",
  bgAlt: "#171922",
  surface: "#171922",
  ink: "#F1F1F4",
  inkMuted: "#9A9BA6",
  border: "rgba(255,255,255,0.12)",
  accent: "#5B75FF",
  success: "#4CAF7D",
  warn: "#E28A63",
  danger: "#E6625A",
};

/** Landing-page-only tokens (marketing page's blobs/shadows/header blur — not needed by the app shell). */
export interface LandingTheme extends Theme {
  inkDarkMuted: string;
  shadow: string;
  headerBg: string;
  accentInk: string;
  blob1: string;
  blob2: string;
}

export const lightLandingTheme: LandingTheme = {
  ...lightTheme,
  inkDarkMuted: "rgba(241,241,244,0.65)",
  shadow: "rgba(20,21,26,0.18)",
  headerBg: "rgba(248,246,241,0.75)",
  accentInk: "#FFFFFF",
  blob1: "radial-gradient(circle,#3452E1,transparent 70%)",
  blob2: "radial-gradient(circle,#1F9E8A,transparent 70%)",
};

export const darkLandingTheme: LandingTheme = {
  ...darkTheme,
  bgAlt: "#12141B",
  inkDarkMuted: "rgba(241,241,244,0.65)",
  shadow: "rgba(0,0,0,0.6)",
  headerBg: "rgba(11,13,18,0.75)",
  accentInk: "#0B0D12",
  blob1: "radial-gradient(circle,#3452E1,transparent 70%)",
  blob2: "radial-gradient(circle,#1F9E8A,transparent 70%)",
};

export function pillColors(theme: Theme, dark: boolean, kind: "success" | "warn" | "danger" | "neutral") {
  if (kind === "success") {
    return { bg: dark ? "rgba(76,175,125,0.18)" : "rgba(47,122,82,0.12)", color: theme.success };
  }
  if (kind === "warn") {
    return { bg: dark ? "rgba(226,138,99,0.18)" : "rgba(181,69,31,0.10)", color: theme.warn };
  }
  if (kind === "danger") {
    return { bg: dark ? "rgba(230,98,90,0.18)" : "rgba(194,59,59,0.10)", color: theme.danger };
  }
  return { bg: dark ? "rgba(154,155,166,0.18)" : "rgba(91,92,102,0.10)", color: theme.inkMuted };
}

export const fonts = {
  heading: "'Unbounded', sans-serif",
  body: "'Sora', sans-serif",
  mono: "'JetBrains Mono', monospace",
};
