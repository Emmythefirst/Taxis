/**
 * Decimal-string <-> base-unit conversion for on-chain token amounts.
 *
 * Money amounts must never round-trip through floating-point multiplication
 * (e.g. `Number(decimal) * 10 ** decimals` can misround real amounts due to
 * binary floating-point representation). This does the conversion via
 * string manipulation instead, which is exact for any decimal input with no
 * more fractional digits than the token supports.
 */

export function parseDecimalToBaseUnits(decimal: string, decimals: number): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = "0", fractionalPart = ""] = unsigned.split(".");
  if (fractionalPart.length > decimals) {
    throw new Error(
      `Amount "${decimal}" has more fractional digits (${fractionalPart.length}) than the token's decimals (${decimals})`,
    );
  }
  const paddedFraction = fractionalPart.padEnd(decimals, "0");
  const baseUnits = BigInt(wholePart + paddedFraction || "0");
  return negative ? -baseUnits : baseUnits;
}

export function formatBaseUnitsToDecimal(baseUnits: bigint, decimals: number): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const str = abs.toString().padStart(decimals + 1, "0");
  const wholePart = str.slice(0, str.length - decimals);
  const fractionalPart = str.slice(str.length - decimals).replace(/0+$/, "");
  const result = fractionalPart ? `${wholePart}.${fractionalPart}` : wholePart;
  return negative ? `-${result}` : result;
}
