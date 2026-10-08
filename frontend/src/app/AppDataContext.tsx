import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import * as endpoints from "../api/endpoints";
import { syncUser } from "../api/client";
import type { ContinuityStatus } from "../api/endpoints";
import type { Checkout, Cycle, Grant, ObligationEnvelope, Recipient } from "../types";

export interface CycleWithObligation {
  obligationId: string;
  cycle: Cycle;
}

export interface GrantWithObligation {
  obligationId: string;
  grant: Grant;
}

interface AppData {
  userId: string;
  walletAddress: string | undefined;
  agentQuorumId: string | undefined; // learned from the first obligation-creation response
  balance: string | undefined;
  recipients: Recipient[];
  obligations: ObligationEnvelope[];
  cycles: CycleWithObligation[];
  grants: GrantWithObligation[];
  checkouts: Checkout[];
  continuity: ContinuityStatus | undefined;
  loading: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
  setAgentQuorumId: (id: string) => void;
}

const AppDataContext = createContext<AppData | undefined>(undefined);

/**
 * Loads everything the authenticated app's screens read, once, and exposes
 * a refresh() to refetch after a mutation (new obligation, approve/skip a
 * cycle, a checkout settling, kill switch, check-in, renewal, continuity
 * setup). Deliberately one shared fetch rather than each screen fetching
 * independently — most screens read overlapping data (obligations + their
 * cycles show up on Dashboard, Payments, and Activity alike).
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const userId = user?.id;
  // Real bug, found live: `wallets[0]` is NOT reliably the Taxis embedded
  // wallet — useWallets() can surface other wallet-like entries too (a
  // browser extension, a different chain type, anything else Privy
  // detects), and whichever sorts first isn't guaranteed to be the one
  // actually linked to this user. Confirmed directly: addSigners() kept
  // throwing "Address to add signers too is not associated with current
  // user" because `wallets[0].address` didn't match ANYTHING in
  // user.linkedAccounts, while the genuinely linked wallet was sitting
  // further down the array. `walletClientType === "privy"` is Privy's own
  // documented way to identify the real embedded wallet — it's the exact
  // same field their own SDK checks internally for this same validation,
  // so matching on it here can't disagree with what addSigners() expects.
  const walletAddress = wallets.find((w) => w.walletClientType === "privy")?.address;

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [obligations, setObligations] = useState<ObligationEnvelope[]>([]);
  const [cycles, setCycles] = useState<CycleWithObligation[]>([]);
  const [grants, setGrants] = useState<GrantWithObligation[]>([]);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [continuity, setContinuity] = useState<ContinuityStatus | undefined>(undefined);
  const [balance, setBalance] = useState<string | undefined>(undefined);
  const [agentQuorumId, setAgentQuorumId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(undefined);
    try {
      // Real bug, found live: Onboarding.tsx was the ONLY place that ever
      // called /users/sync, so AppShell's render guard (which only checks
      // `authenticated`, never whether the backend's wallet record is
      // fresh) let an already-authenticated visitor reach /app directly —
      // a bookmark, a typed URL, a reopened tab — without ever syncing.
      // The backend's cached wallet_address then silently diverges from
      // Privy's real live wallet (the one actually shown/used client-side,
      // via useWallets() above), and every wallet-address-dependent read
      // (balance, in particular) queries the stale address and looks
      // broken — e.g. a real funded wallet showing $0. Re-syncing here,
      // every time AppDataProvider mounts, closes the gap for every path
      // into /app, not just the one that happens to pass through
      // Onboarding. Cheap and idempotent (an upsert + a Privy wallet
      // lookup) — safe to call on every refresh(), not just once.
      try {
        await syncUser(userId);
      } catch {
        // Don't let a sync hiccup (the same transient network failures
        // this project has hit against Privy before) block the rest of
        // the app's data from loading — worst case, wallet-dependent
        // reads stay stale until the next successful refresh() picks it
        // up, same as before this fix existed.
      }

      const [recipientsRes, obligationsRes, checkoutsRes] = await Promise.all([
        endpoints.listRecipients(userId),
        endpoints.listObligations(userId),
        endpoints.listCheckouts(userId),
      ]);
      setRecipients(recipientsRes.recipients);
      setObligations(obligationsRes.obligations);
      setCheckouts(checkoutsRes.checkouts);

      const [cyclesByObligation, grantsByObligation] = await Promise.all([
        Promise.all(
          obligationsRes.obligations.map(async (o) => {
            const { cycles } = await endpoints.listCycles(o.id);
            return cycles.map((cycle): CycleWithObligation => ({ obligationId: o.id, cycle }));
          }),
        ),
        Promise.all(
          obligationsRes.obligations.map(async (o) => {
            const { grants } = await endpoints.listGrants(o.id);
            return grants.map((grant): GrantWithObligation => ({ obligationId: o.id, grant }));
          }),
        ),
      ]);
      setCycles(cyclesByObligation.flat());
      setGrants(grantsByObligation.flat());

      // Balance reading and continuity status both need live deps configured
      // server-side — absent in a not-fully-configured server (503 / a
      // plain "not configured" response). Don't let either block the rest
      // of the app's data from loading.
      try {
        const { ausdBalance } = await endpoints.getBalance(userId);
        setBalance(ausdBalance);
      } catch {
        setBalance(undefined);
      }
      try {
        setContinuity(await endpoints.getContinuityStatus(userId));
      } catch {
        setContinuity(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AppData | undefined>(() => {
    if (!userId) return undefined;
    return {
      userId,
      walletAddress,
      agentQuorumId,
      balance,
      recipients,
      obligations,
      cycles,
      grants,
      checkouts,
      continuity,
      loading,
      error,
      refresh,
      setAgentQuorumId,
    };
  }, [userId, walletAddress, agentQuorumId, balance, recipients, obligations, cycles, grants, checkouts, continuity, loading, error, refresh]);

  if (!value) return null; // AppShell already redirects unauthenticated users before rendering this

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData() must be used within AppDataProvider");
  return ctx;
}
