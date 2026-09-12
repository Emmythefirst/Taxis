/**
 * Quote engine end-to-end proof — runs one real obligation cycle through
 * `engine/quoteEngine.ts` against live Monad testnet + Privy infra: builds
 * a durable grant policy, attaches it, runs the full decision loop, signs a
 * real quote, executes a real AUSD transfer, and verifies the signature
 * independently afterward.
 *
 * The grant-attachment step below uses the OWNER quorum's key directly, the
 * same test-harness stand-in used throughout the prior spikes (see
 * progress.md Build Log) — in the real product this step is a CLIENT-SIDE
 * `useSigners().addSigners()` call made while the actual user is
 * authenticated (privy/policy.ts's header comment explains why). This
 * script only exists to prove the quote engine itself works end-to-end;
 * it is not a template for how the backend grants sessions in production.
 *
 * Reuses the wallet/quorums already set up by privy-kill-test.ts.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createGrantPolicy } from "../src/privy/policy.js";
import { createPrivyTransferExecutor } from "../src/privy/execute.js";
import { runCycle } from "../src/engine/quoteEngine.js";
import { createCycle } from "../src/domain/cycleStateMachine.js";
import { CumulativeCapStore } from "../src/domain/reservation.js";
import { deriveQuoteSigningPublicKey, verifyQuoteSignature } from "../src/quoting/signing.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";
import type { QuoteInputs } from "../src/domain/decisionLoop.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const agentQuorumId = requireEnv("PRIVY_AGENT_KEY_QUORUM_ID");
  const ownerQuorumId = requireEnv("PRIVY_OWNER_KEY_QUORUM_ID");
  const agentPrivateKeyB64 = requireEnv("PRIVY_AGENT_PRIVATE_KEY_B64");
  const ownerPrivateKeyB64 = requireEnv("PRIVY_OWNER_PRIVATE_KEY_B64");
  const quoteSigningPrivateKey = requireEnv("QUOTE_SIGNING_PRIVATE_KEY") as `0x${string}`;
  const validRecipient = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const walletId = requireEnv("KILL_TEST_WALLET_ID");
  const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
  const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

  const ownerContext = { authorization_private_keys: [ownerPrivateKeyB64] };
  const privy = new PrivyClient({ appId, appSecret });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  const decimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });
  console.log(`AUSD decimals: ${decimals}`);

  // Ensure owner is set (idempotent; needs owner auth if already set from a prior run).
  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  // --- Grant: create a durable policy and attach it (test stand-in for the
  // real client-side addSigners() flow — see file header). -----------------
  console.log("\nCreating grant policy (recipient + cap + expiry)...");
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 120; // demo "cycle length"
  const grant = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: validRecipient,
    maxAmountBaseUnits: 300_000_000n, // 300 AUSD cap, comfortably above the quote below
    expiresAtUnix,
    label: "Quote engine e2e grant",
  });
  console.log(`  policy id=${grant.policyId}, expires ${new Date(expiresAtUnix * 1000).toISOString()}`);

  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [grant.policyId] }],
  } as any);
  console.log("  attached to agent quorum.");

  // --- Run one real obligation cycle through the actual quote engine ------
  const envelope: ObligationEnvelope = {
    id: "obl_demo",
    userId: "user_demo",
    recipientId: "rcp_demo",
    targetLocalAmount: 300_000, // e.g. NGN
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd: 1000,
    cadence: { kind: "MONTHLY", dayOfMonth: 1 },
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };
  const recipient: Recipient = {
    id: "rcp_demo",
    userId: "user_demo",
    label: "Demo recipient",
    payoutAddress: validRecipient,
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: new Date().toISOString(),
  };
  const inputs: QuoteInputs = {
    fxRate: 1500, // 300000 / 1500 = 200 AUSD principal, under the 210 ceiling
    feeAgentAusd: 1,
    feeNetworkAusd: 0.5,
    availableBalanceAusd: 5000, // wallet has real testnet AUSD from earlier funding
    period: new Date().toISOString().slice(0, 7),
  };

  const cycle = createCycle(envelope.id, `cyc_demo_${Date.now()}`, new Date().toISOString());
  const executor = createPrivyTransferExecutor(privy, {
    walletId,
    ausdAddress,
    chainId,
    agentPrivateKeyB64,
    publicClient,
  });

  console.log("\nRunning one real obligation cycle through the quote engine...");
  const result = await runCycle(cycle, envelope, recipient, inputs, {
    capStore: new CumulativeCapStore(),
    now: () => new Date(),
    makeNonce: () => `nonce_${Date.now()}`,
    quoteSigningPrivateKey,
    ausdDecimals: decimals,
    executor,
  });

  console.log(`\nOutcome: ${result.outcome}`);
  console.log(`Cycle state: ${result.cycle.state}`);

  if (result.outcome === "SETTLED") {
    console.log(`Tx hash: ${result.txHash}`);
    console.log(`Quote: ${result.quote.ausdAmount} AUSD to ${result.quote.recipientAddress}, nonce=${result.quote.nonce}`);
    const publicKey = deriveQuoteSigningPublicKey(quoteSigningPrivateKey);
    const verified = verifyQuoteSignature(result.quote, publicKey);
    console.log(`Quote signature independently verifies: ${verified ? "✅ yes" : "❌ NO"}`);
    process.exit(verified ? 0 : 1);
  } else if (result.outcome === "PENDING_CONFIRMATION") {
    console.log(`Tx hash: ${result.txHash} — broadcast but not confirmed within the timeout.`);
    console.log("Reservation left held (not released) — this would need manual reconciliation, not an automatic retry.");
    process.exit(1);
  } else {
    console.log("reason" in result ? `Reason: ${result.reason}` : "");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Quote engine e2e script crashed:", err);
  process.exit(1);
});
