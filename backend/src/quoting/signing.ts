/**
 * Signs the quote every obligation cycle — and, since it's a generic
 * canonical-object signer, every merchant checkout too — produces
 * (progress.md Section A.3) — the artifact a user sees and can
 * independently verify before any funds move. Deliberately a SEPARATE
 * keypair from anything Privy-related: the agent/owner quorum keys
 * authorize Privy API calls (P-256, Privy's own canonicalization); this key
 * exists purely so Taxis's own quote claims are independently verifiable,
 * on their own terms, by anyone holding the public key — including,
 * eventually, on-chain.
 *
 * Generic over the quote shape (`Quote` for obligation cycles,
 * `CheckoutQuote` for one-off merchant checkouts — both just plain
 * serializable objects with a `signature?: Hex` field) rather than hardcoded
 * to `Quote`, since the actual signing mechanism has no dependency on which
 * one it is.
 *
 * Synchronous by design so it composes directly with decisionLoop.ts's
 * synchronous `sign` dependency (viem's account.signMessage() is async, and
 * threading that through would force the whole decision loop — and every
 * existing test calling it without `await` — to become async for no
 * behavioral gain). Uses secp256k1 directly, mirroring the same
 * hash-then-sign pattern confirmed by reading Privy's own SDK source for
 * its P-256 authorization signatures (sha256 of a canonical payload, DER
 * signature).
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { Hex } from "../domain/types.js";

function canonicalPayloadBytes(unsigned: Record<string, unknown>): Uint8Array {
  const sortedKeys = Object.keys(unsigned).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = unsigned[key];
  }
  return new TextEncoder().encode(JSON.stringify(sorted));
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

export function deriveQuoteSigningPublicKey(privateKeyHex: Hex): Hex {
  const privateKeyBytes = hexToBytes(stripHexPrefix(privateKeyHex));
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true); // compressed
  return `0x${bytesToHex(publicKeyBytes)}` as Hex;
}

export function signQuote<T extends Record<string, unknown>>(unsigned: T, privateKeyHex: Hex): Hex {
  const privateKeyBytes = hexToBytes(stripHexPrefix(privateKeyHex));
  const hash = sha256(canonicalPayloadBytes(unsigned));
  const signature = secp256k1.sign(hash, privateKeyBytes);
  return `0x${bytesToHex(signature.toDERRawBytes())}` as Hex;
}

export function verifyQuoteSignature<T extends { signature?: Hex }>(quote: T, publicKeyHex: Hex): boolean {
  if (!quote.signature) return false;
  const { signature, ...unsigned } = quote;
  const hash = sha256(canonicalPayloadBytes(unsigned as Record<string, unknown>));
  const signatureBytes = hexToBytes(stripHexPrefix(signature));
  const publicKeyBytes = hexToBytes(stripHexPrefix(publicKeyHex));
  return secp256k1.verify(signatureBytes, hash, publicKeyBytes);
}
