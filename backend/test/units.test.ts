import { describe, expect, it } from "vitest";
import { formatBaseUnitsToDecimal, parseDecimalToBaseUnits } from "../src/domain/units.js";

describe("parseDecimalToBaseUnits", () => {
  it("converts an exact decimal amount without floating-point drift", () => {
    // Float multiplication (201.5 * 10**6) can drift in JS; string-based
    // conversion must not.
    expect(parseDecimalToBaseUnits("201.5", 6)).toBe(201_500_000n);
  });

  it("handles whole numbers and short fractions", () => {
    expect(parseDecimalToBaseUnits("10", 6)).toBe(10_000_000n);
    expect(parseDecimalToBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("handles negative amounts", () => {
    expect(parseDecimalToBaseUnits("-5.25", 6)).toBe(-5_250_000n);
  });

  it("rejects more fractional digits than the token supports", () => {
    expect(() => parseDecimalToBaseUnits("1.1234567", 6)).toThrow(/more fractional digits/);
  });
});

describe("formatBaseUnitsToDecimal", () => {
  it("round-trips with parseDecimalToBaseUnits", () => {
    expect(formatBaseUnitsToDecimal(201_500_000n, 6)).toBe("201.5");
    expect(formatBaseUnitsToDecimal(10_000_000n, 6)).toBe("10");
    expect(formatBaseUnitsToDecimal(1n, 6)).toBe("0.000001");
  });

  it("handles negative amounts", () => {
    expect(formatBaseUnitsToDecimal(-5_250_000n, 6)).toBe("-5.25");
  });
});
