/**
 * Shared market-data interface — used by both the recurring-obligation
 * scheduler (scheduler/runDueCycles.ts) and merchant checkout
 * (engine/checkoutEngine.ts).
 *
 * Two implementations:
 * - `staticMarketDataProvider` — a clearly flagged placeholder, one flat
 *   rate for every currency. Was genuinely wrong for 3 of the 4 countries
 *   the app offers (NGN/GHS/KES/PHP have real rates roughly 1300/11/130/63
 *   per USD — nothing close to the same number), not just "simulated."
 * - `liveMarketDataProvider` — real per-currency rates from a free,
 *   keyless FX API (confirmed live: open.er-api.com, covers all four
 *   currencies this project offers). Fees stay operator-set env-var
 *   values either way — there's no equivalent "real" source for Taxis's
 *   own agent/network fee, those are genuinely a product choice, not
 *   external market data.
 *
 * Either way, the quotes produced are fully real and signed, and executed
 * transfers are genuine on-chain transactions — this module only ever
 * affects the INPUT numbers feeding the decision, never whether execution
 * itself is real.
 */

export interface MarketDataProvider {
  /** Local-currency units per 1 AUSD. */
  getFxRate(localCurrency: string): number;
  getFees(): { agentAusd: number; networkAusd: number };
}

export function staticMarketDataProvider(): MarketDataProvider {
  const fxRate = Number(process.env.DEMO_FX_RATE ?? "1500");
  const feeAgentAusd = Number(process.env.DEMO_FEE_AGENT_AUSD ?? "1");
  const feeNetworkAusd = Number(process.env.DEMO_FEE_NETWORK_AUSD ?? "0.5");
  return {
    // "USD"/"AUSD" merchants (e.g. the checkout demo screen's same-currency
    // purchase) settle 1:1 — no cross-border FX conversion applies. Every
    // other currency uses the single flat placeholder rate (see file
    // header: not a real per-currency FX source).
    getFxRate: (localCurrency) => (localCurrency === "USD" || localCurrency === "AUSD" ? 1 : fxRate),
    getFees: () => ({ agentAusd: feeAgentAusd, networkAusd: feeNetworkAusd }),
  };
}

const LIVE_FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const LIVE_FX_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // the API itself only updates ~daily; this just bounds staleness

interface LiveFxApiResponse {
  result?: string;
  rates?: Record<string, number>;
}

/**
 * Real per-currency FX, refreshed on a background interval — NOT fetched
 * inside getFxRate() itself, deliberately: every caller in this codebase
 * (decisionLoop.ts, quoteEngine.ts, checkoutEngine.ts) treats
 * MarketDataProvider as synchronous, and making it async would ripple
 * through all of them and their tests for no real benefit. A background
 * refresh + synchronous read of the last-known snapshot keeps the
 * interface unchanged.
 *
 * Fails safe, never fails loud: if the fetch errors, is rate-limited, or
 * returns something unexpected, this keeps serving the last successfully
 * fetched rates (or the static placeholder if nothing has succeeded yet)
 * rather than throwing — a live demo should degrade to "simulated," not
 * crash, if a venue's wifi drops mid-cycle. Logged clearly either way so
 * it's never a silent switch.
 */
export function liveMarketDataProvider(): MarketDataProvider {
  const fallbackFxRate = Number(process.env.DEMO_FX_RATE ?? "1500");
  const feeAgentAusd = Number(process.env.DEMO_FEE_AGENT_AUSD ?? "1");
  const feeNetworkAusd = Number(process.env.DEMO_FEE_NETWORK_AUSD ?? "0.5");

  let rates: Record<string, number> | undefined;

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(LIVE_FX_API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as LiveFxApiResponse;
      if (body.result !== "success" || !body.rates) throw new Error("unexpected response shape");
      rates = body.rates;
      console.log(`Live FX rates refreshed (${Object.keys(rates).length} currencies, e.g. NGN=${rates.NGN}).`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(
        `Live FX refresh failed (${reason}) — ${rates ? "keeping last known live rates" : `falling back to DEMO_FX_RATE=${fallbackFxRate} until the next successful refresh`}.`,
      );
    }
  }

  void refresh();
  const interval = setInterval(() => void refresh(), LIVE_FX_REFRESH_INTERVAL_MS);
  interval.unref?.(); // a background refresh timer should never be the reason the process won't exit

  return {
    getFxRate: (localCurrency) => {
      if (localCurrency === "USD" || localCurrency === "AUSD") return 1;
      return rates?.[localCurrency] ?? fallbackFxRate;
    },
    getFees: () => ({ agentAusd: feeAgentAusd, networkAusd: feeNetworkAusd }),
  };
}
