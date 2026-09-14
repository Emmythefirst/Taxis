import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import * as endpoints from "../api/endpoints";
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
  const walletAddress = wallets[0]?.address;

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
