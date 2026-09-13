/**
 * Merchant checkout end-to-end proof — runs the real createCheckout() /
 * executeCheckout() pair against live Monad testnet + Privy infra: a real
 * single-use policy, a real signed checkout quote, a real executed AUSD
 * transfer to a "merchant" address, and independent signature verification.
 *
 * Unlike the continuity (dead-man's-switch) feature, checkout needs no new
 * Privy dashboard setup — it reuses the same owner/agent quorums already
 * registered for the kill-test spike. The owner-signed policy attachment
 * below is still the usual test-harness stand-in for the real client-side
 * "Approve payment" tap (see privy/policy.ts's header) — everything
 * downstream of that is exactly the real production code path.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createPrivyTransferExecutor } from "../src/privy/execute.js";
import { openDb } from "../src/persistence/db.js";
import { insertUser } from "../src/persistence/users.js";
import { createCheckout, executeCheckout } from "../src/engine/checkoutEngine.js";
import { deriveQuoteSigningPublicKey, verifyQuoteSignature } from "../src/quoting/signing.js";
import { formatBaseUnitsToDecimal } from "../src/domain/units.js";

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
  const merchantAddress = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`; // stands in for "the merchant"
  const walletId = requireEnv("KILL_TEST_WALLET_ID");
  const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
  const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

  const ownerContext = { authorization_private_keys: [ownerPrivateKeyB64] };
  const privy = new PrivyClient({ appId, appSecret });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const ausdDecimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });
  console.log(`AUSD decimals: ${ausdDecimals}`);

  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  const db = openDb(":memory:");
  insertUser(db, "user_checkout_demo");

  const wallet = await privy.wallets().get(walletId);
  const walletAddress = (wallet as any).address as `0x${string}`;
  const balance = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [walletAddress] });
  const availableBalanceAusd = Number(formatBaseUnitsToDecimal(balance, ausdDecimals));
  console.log(`Wallet balance: ${availableBalanceAusd} AUSD`);

  console.log("\nCreating checkout quote (real single-use policy)...");
  const created = await createCheckout(
    {
      db,
      privy,
      now: () => new Date(),
      makeNonce: () => `nonce_${Date.now()}`,
      quoteSigningPrivateKey,
      ausdAddress,
      ausdDecimals,
      fxRate: 1500,
      feeAgentAusd: 0.5,
      feeNetworkAusd: 0.25,
      availableBalanceAusd,
      expirySeconds: 600,
    },
    { userId: "user_checkout_demo", merchantAddress, localAmount: 15_000, localCurrency: "NGN" },
  );

  if (created.outcome !== "QUOTED") {
    console.error(`Could not create checkout: ${created.reason}`);
    process.exit(1);
  }
  console.log(`  checkout id=${created.checkout.id}, policy id=${created.policyId}`);
  console.log(`  quote: ${created.checkout.quote.ausdAmount} AUSD to ${created.checkout.quote.merchantAddress}`);

  console.log("\nAttaching policy (test stand-in for the live 'Approve payment' tap)...");
  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [created.policyId] }],
  } as any);
  console.log("  attached to agent quorum.");

  console.log("\nExecuting the checkout...");
  const executor = createPrivyTransferExecutor(privy, { walletId, ausdAddress, chainId, agentPrivateKeyB64, publicClient });
  const outcome = await executeCheckout({ db, ausdDecimals, executor }, created.checkout.id);

  console.log(`\nOutcome: ${outcome.outcome}`);
  if (outcome.outcome === "SETTLED") {
    console.log(`Tx hash: ${outcome.txHash}`);
    const publicKey = deriveQuoteSigningPublicKey(quoteSigningPrivateKey);
    const verified = verifyQuoteSignature(created.checkout.quote, publicKey);
    console.log(`Quote signature independently verifies: ${verified ? "✅ yes" : "❌ NO"}`);
    process.exit(verified ? 0 : 1);
  } else {
    console.log(JSON.stringify(outcome, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Checkout e2e script crashed:", err);
  process.exit(1);
});
