import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { darkTheme, lightTheme, type Theme } from "../theme/theme";

interface ThemeContextValue {
  theme: Theme;
  dark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "taxis-theme-dark";

function loadInitialDark(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Mounted ONCE at the app root (main.tsx) — not per-page. It used to only
 * wrap AppShell's /app/* routes, while Landing and Onboarding each kept
 * their own separate local `dark` state; toggling the theme on one page had
 * no effect on the others. One shared store, persisted, fixes both: theme
 * now follows you across every page AND survives a reload.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(loadInitialDark);
  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: dark ? darkTheme : lightTheme,
      dark,
      toggleTheme: () =>
        setDark((d) => {
          const next = !d;
          try {
            localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
          } catch {
            // Private browsing / storage disabled — theme just won't persist.
          }
          return next;
        }),
    }),
    [dark],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useAppTheme() must be used within ThemeProvider");
  return ctx;
}
