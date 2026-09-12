import { describe, expect, it } from "vitest";
import { deriveQuoteSigningPublicKey, signQuote, verifyQuoteSignature } from "../src/quoting/signing.js";
import type { Quote } from "../src/domain/types.js";

// Test-only keys — never real secrets. Exactly 32 bytes (64 hex chars).
const PRIVATE_KEY = `0x${"ab".repeat(32)}` as const;

function makeUnsignedQuote(overrides: Partial<Quote> = {}): Omit<Quote, "signature"> {
  const { signature: _signature, ...unsigned } = {
    obligationId: "obl_1",
    cycleId: "cyc_1",
    recipientAddress: "0x000000000000000000000000000000000000aa",
    localAmount: 300_000,
    localCurrency: "NGN",
    ausdAmount: "201.5",
    fxRateLockedAt: "2026-10-01T09:00:00.000Z",
    fxRate: 1500,
    feeAgentAusd: "1",
    feeNetworkAusd: "0.5",
    nonce: "nonce_0",
    issuedAt: "2026-10-01T09:00:00.000Z",
    expiresAt: "2026-10-01T09:05:00.000Z",
    signature: undefined,
    ...overrides,
  } satisfies Quote;
  return unsigned;
}

describe("quote signing", () => {
  it("produces a signature that verifies against the matching public key", () => {
    const unsigned = makeUnsignedQuote();
    const signature = signQuote(unsigned, PRIVATE_KEY);
    const publicKey = deriveQuoteSigningPublicKey(PRIVATE_KEY);
    const quote: Quote = { ...unsigned, signature };

    expect(verifyQuoteSignature(quote, publicKey)).toBe(true);
  });

  it("fails verification if any quote field changes after signing", () => {
    const unsigned = makeUnsignedQuote();
    const signature = signQuote(unsigned, PRIVATE_KEY);
    const publicKey = deriveQuoteSigningPublicKey(PRIVATE_KEY);

    // Attacker/bug bumps the amount after the quote was signed.
    const tampered: Quote = { ...unsigned, signature, ausdAmount: "999999" };
    expect(verifyQuoteSignature(tampered, publicKey)).toBe(false);
  });

  it("fails verification against the wrong public key", () => {
    const unsigned = makeUnsignedQuote();
    const signature = signQuote(unsigned, PRIVATE_KEY);
    const otherKey = `0x${"cd".repeat(32)}` as const;
    const wrongPublicKey = deriveQuoteSigningPublicKey(otherKey);
    const quote: Quote = { ...unsigned, signature };

    expect(verifyQuoteSignature(quote, wrongPublicKey)).toBe(false);
  });

  it("is deterministic for a given key + payload (same signature every time)", () => {
    const unsigned = makeUnsignedQuote();
    expect(signQuote(unsigned, PRIVATE_KEY)).toBe(signQuote(unsigned, PRIVATE_KEY));
  });
});
