/**
 * Shared market-data interface — used by both the recurring-obligation
 * scheduler (scheduler/runDueCycles.ts) and merchant checkout
 * (engine/checkoutEngine.ts). `staticMarketDataProvider` is a clearly
 * flagged placeholder, not a real FX/fee integration: no real FX API is
 * wired up yet. The quotes it feeds are still fully real and signed, and
 * executed transfers are still genuine on-chain transactions — only the
 * market data itself is fake. Do not ship a real remittance product on
 * this.
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
