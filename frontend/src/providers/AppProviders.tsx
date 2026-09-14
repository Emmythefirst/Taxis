import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { BrowserRouter } from "react-router-dom";

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

export function AppProviders({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) {
    throw new Error("Missing VITE_PRIVY_APP_ID — set it in frontend/.env (see .env.example)");
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: "light", accentColor: "#3452E1" },
        // Section A.4: no seed phrase, embedded wallet created automatically
        // on login — this is the real version of what every backend spike
        // this project has proven so far used a test-harness stand-in for.
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <BrowserRouter>{children}</BrowserRouter>
    </PrivyProvider>
  );
}
