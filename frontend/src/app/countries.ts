export interface CountryOption {
  name: string;
  currency: string;
}

/** Matches the decoded design's exact country chip set. */
export const COUNTRY_OPTIONS: CountryOption[] = [
  { name: "Nigeria", currency: "NGN" },
  { name: "Ghana", currency: "GHS" },
  { name: "Kenya", currency: "KES" },
  { name: "Philippines", currency: "PHP" },
];
