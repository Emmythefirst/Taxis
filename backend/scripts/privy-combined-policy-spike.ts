/**
 * Follow-up to privy-multi-policy-spike.ts, which proved a signer can hold
 * only ONE policy. The remaining open question for engine/operationsPolicy.ts's
 * fix: does a single policy with MULTIPLE RULES (mutually-exclusive
 * recipient conditions, exactly like the obligation-A/obligation-B case)
 * evaluate as OR-across-rules (any one rule matching is enough — the
 * standard assumption for policy engines, and what the fix depends on) or
 * something else entirely?
 *
 * Builds ONE policy with two rules (recipient A only / recipient B only,
 * same shape as privy/policy.ts's buildCombinedPolicyRequest), attaches it
 * as the agent signer's single policy, and attempts a transfer to each
 * recipient.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createCombinedPolicy } from "../src/privy/policy.js";

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
  const recipientA = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const recipientB = requireEnv("KILL_TEST_WRONG_RECIPIENT") as `0x${string}`;
  const walletId = requireEnv("KILL_TEST_WALLET_ID");
  const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
  const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

  const ownerContext = { authorization_private_keys: [ownerPrivateKeyB64] };
  const privy = new PrivyClient({ appId, appSecret });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });

  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  console.log("Creating ONE policy with TWO rules (recipient A only / recipient B only)...");
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 300;
  const combined = await createCombinedPolicy(privy, [
    { ausdAddress, recipientAddress: recipientA, maxAmountBaseUnits: 1_000_000n, expiresAtUnix, label: "Combined spike rule A" },
    { ausdAddress, recipientAddress: recipientB, maxAmountBaseUnits: 1_000_000n, expiresAtUnix, label: "Combined spike rule B" },
  ]);
  console.log(`  combined policy id=${combined.policyId}`);

  console.log("\nAttaching the single combined policy to the agent signer...");
  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [combined.policyId] }],
  } as any);
  console.log("  attached.");

  async function attempt(label: string, recipient: `0x${string}`): Promise<boolean> {
    try {
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient, 1n] });
      const res = await privy
        .wallets()
        .ethereum()
        .sendTransaction(walletId, {
          caip2: `eip155:${chainId}`,
          authorization_context: { authorization_private_keys: [agentPrivateKeyB64] },
          params: { transaction: { to: ausdAddress, data, chain_id: chainId } },
        } as any);
      console.log(`  ${label}: ALLOWED (hash ${(res as any).hash})`);
      return true;
    } catch (err) {
      console.log(`  ${label}: REJECTED (${err instanceof Error ? err.message : err})`);
      return false;
    }
  }

  console.log("\nAttempting a transfer to recipient A (matches rule A only)...");
  const aAllowed = await attempt("Transfer to A", recipientA);

  console.log("\nAttempting a transfer to recipient B (matches rule B only)...");
  const bAllowed = await attempt("Transfer to B", recipientB);

  console.log("\n--- Result ---");
  if (aAllowed && bAllowed) {
    console.log("✅ Rules within one policy are OR-combined: a transaction is allowed if it matches ANY rule.");
    console.log("   engine/operationsPolicy.ts's combined-policy fix is sound.");
  } else if (!aAllowed && !bAllowed) {
    console.log("❌ Rules within one policy are AND-combined — mutually exclusive recipient rules brick everything.");
    console.log("   The combined-policy fix does NOT work as designed. Needs a different approach entirely.");
  } else {
    console.log("⚠ Inconsistent result — investigate further before relying on this.");
  }
  process.exit(aAllowed && bAllowed ? 0 : 1);
}

main().catch((err) => {
  console.error("Combined-policy spike crashed:", err);
  process.exit(1);
});
