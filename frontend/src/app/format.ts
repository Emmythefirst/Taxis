import type { Cadence } from "../types";

export function formatCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case "WEEKLY":
      return "Weekly";
    case "BIWEEKLY":
      return "Biweekly";
    case "MONTHLY":
      return "Monthly";
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = { NGN: "₦", GHS: "₵", KES: "KSh ", PHP: "₱", USD: "$" };

export function formatLocalAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${amount.toLocaleString()}`;
}

export function formatUsd(amount: number | string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `$${n.toFixed(2)}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
