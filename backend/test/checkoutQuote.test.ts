import { describe, expect, it } from "vitest";
import { buildCheckoutQuote, type CheckoutQuoteInputs } from "../src/domain/checkoutQuote.js";
import { deriveQuoteSigningPublicKey, signQuote, verifyQuoteSignature } from "../src/quoting/signing.js";

const QUOTE_SIGNING_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

function deps(nonce = "nonce_0") {
  return {
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    makeNonce: () => nonce,
    sign: (unsigned: Parameters<typeof signQuote>[0]) => signQuote(unsigned, QUOTE_SIGNING_PRIVATE_KEY),
  };
}

const baseInputs: CheckoutQuoteInputs = {
  merchantAddress: "0x000000000000000000000000000000000000cc",
  localAmount: 15_000,
  localCurrency: "NGN",
  fxRate: 1500, // 10 AUSD principal
  feeAgentAusd: 0.5,
  feeNetworkAusd: 0.25,
  availableBalanceAusd: 100,
  expirySeconds: 600,
};

describe("buildCheckoutQuote", () => {
  it("produces a signed, verifiable quote when the balance is sufficient", () => {
    const result = buildCheckoutQuote("checkout_1", baseInputs, deps());
    expect(result.outcome).toBe("QUOTED");
    if (result.outcome !== "QUOTED") throw new Error("expected QUOTED");

    expect(result.quote.ausdAmount).toBe("10.75"); // 10 + 0.5 + 0.25
    expect(result.quote.merchantAddress).toBe(baseInputs.merchantAddress);
    expect(result.quote.expiresAt).toBe("2026-10-01T09:10:00.000Z"); // +600s

    const publicKey = deriveQuoteSigningPublicKey(QUOTE_SIGNING_PRIVATE_KEY);
    expect(verifyQuoteSignature(result.quote, publicKey)).toBe(true);
  });

  it("check-then-quote: refuses to issue a quote the balance can't cover", () => {
    const result = buildCheckoutQuote("checkout_1", { ...baseInputs, availableBalanceAusd: 1 }, deps());
    expect(result.outcome).toBe("INSUFFICIENT_BALANCE");
    if (result.outcome !== "INSUFFICIENT_BALANCE") throw new Error("expected INSUFFICIENT_BALANCE");
    expect(result.reason).toMatch(/Insufficient balance/);
  });

  it("is deterministic given the same nonce and inputs (no hidden randomness)", () => {
    const a = buildCheckoutQuote("checkout_1", baseInputs, deps("fixed-nonce"));
    const b = buildCheckoutQuote("checkout_1", baseInputs, deps("fixed-nonce"));
    expect(a).toEqual(b);
  });
});
