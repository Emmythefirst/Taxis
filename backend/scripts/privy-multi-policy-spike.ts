/**
 * Multi-policy-on-one-signer spike — resolves a real gap surfaced while
 * designing the frontend's "New Payment" flow for a SECOND obligation.
 *
 * Every obligation gets its own Privy policy (recipient + cap + expiry),
 * but all of a user's day-to-day obligations share the SAME agent quorum
 * (Section A.6/A.8 — continuity gets a dedicated quorum specifically to
 * avoid this exact ambiguity for mutually-exclusive recipient conditions,
 * but that reasoning was never actually tested for the "two ordinary
 * obligations, same signer" case). Two open questions this settles:
 *
 *   1. Does attaching a signer's policy list via `additional_signers`
 *      REPLACE the existing list, or ADD to it? ("override_policy_ids"
 *      strongly suggests replace, but never confirmed empirically.)
 *   2. When a signer has MULTIPLE policies with mutually-exclusive
 *      recipient conditions (obligation A only allows recipient A,
 *      obligation B only allows recipient B), are transactions evaluated
 *      as OR-across-policies (any one policy matching is enough) or
 *      AND-across-policies (every policy must match, which would mean NO
 *      transaction to either recipient could ever pass, since no single
 *      transaction can satisfy two mutually-exclusive recipient conditions
 *      at once)?
 *
 * If the answer is AND, the frontend cannot simply attach a new policy
 * array containing every obligation's policy id — it would silently brick
 * every existing obligation, including the new one. This must be known
 * BEFORE wiring New Payment's real submit flow, not assumed.
 *
 * Reuses the same wallet/owner/agent quorum setup as the other spikes.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createGrantPolicy } from "../src/privy/policy.js";

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
  const recipientB = requireEnv("KILL_TEST_WRONG_RECIPIENT") as `0x${string}`; // reused purely as a second distinct address
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

  console.log("Creating policy A (recipient A only)...");
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 300;
  const policyA = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: recipientA,
    maxAmountBaseUnits: 1_000_000n, // 1 AUSD @ 6 decimals — tiny, this is just a signing-layer check
    expiresAtUnix,
    label: "Multi-policy spike A",
  });
  console.log(`  policy A id=${policyA.policyId}`);

  console.log("Creating policy B (recipient B only)...");
  const policyB = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: recipientB,
    maxAmountBaseUnits: 1_000_000n,
    expiresAtUnix,
    label: "Multi-policy spike B",
  });
  console.log(`  policy B id=${policyB.policyId}`);

  console.log("\nAttaching BOTH policies to the SAME agent signer in one update...");
  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [policyA.policyId, policyB.policyId] }],
  } as any);
  console.log("  attached.");

  async function attempt(label: string, recipient: `0x${string}`): Promise<boolean> {
    try {
      const { encodeFunctionData } = await import("viem");
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

  console.log("\nAttempting a transfer to recipient A (matches policy A only)...");
  const aAllowed = await attempt("Transfer to A", recipientA);

  console.log("\nAttempting a transfer to recipient B (matches policy B only)...");
  const bAllowed = await attempt("Transfer to B", recipientB);

  console.log("\n--- Result ---");
  if (aAllowed && bAllowed) {
    console.log("✅ OR semantics confirmed: a transaction is allowed if it matches ANY policy in the signer's list.");
    console.log("   Safe design: the frontend can attach the full accumulated set of a user's active obligation policyIds on this signer.");
  } else if (!aAllowed && !bAllowed) {
    console.log("❌ AND semantics confirmed: a transaction must match EVERY policy in the list — mutually exclusive recipients brick everything.");
    console.log("   Multiple concurrent obligations CANNOT share one agent signer this way. Each obligation needs either its own dedicated signer/quorum, or a single combined policy covering all current recipients must be regenerated (owner-signed) on every obligation change.");
  } else {
    console.log("⚠ Inconsistent result — investigate further before relying on this for production logic.");
  }
  process.exit(aAllowed && bAllowed ? 0 : 1);
}

main().catch((err) => {
  console.error("Multi-policy spike crashed:", err);
  process.exit(1);
});
