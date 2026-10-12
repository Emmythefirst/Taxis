export interface CountryOption {
  name: string;
  currency: string;
}

// Original four match the decoded design's exact country chip set — the
// initial remittance corridors. USD and EUR added after: USD is already a
// 1:1 no-op against AUSD's own peg (pricing/marketData.ts special-cases
// it), but EUR is a real, independently-floating currency where the
// rate-tolerance mechanism means the same thing it does for NGN/GHS/KES/
// PHP, extending the product past Sub-Saharan Africa/Southeast Asia
// corridors into developed-market cross-border payments too.
export const COUNTRY_OPTIONS: CountryOption[] = [
  { name: "Nigeria", currency: "NGN" },
  { name: "Ghana", currency: "GHS" },
  { name: "Kenya", currency: "KES" },
  { name: "Philippines", currency: "PHP" },
  { name: "United States", currency: "USD" },
  { name: "Eurozone", currency: "EUR" },
];
