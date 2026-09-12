/**
 * Privy kill-test spike — progress.md Section A.16.
 *
 * Runs the 10-step pass/fail gate against real Privy + Monad testnet infra,
 * before any more of the app gets built on top of the session-key custody
 * model. If steps 5-10 don't cleanly hold, that's a signal to redesign the
 * custody architecture now, not discover it later.
 *
 *   1. Create a Privy embedded wallet.
 *   2. Fund it with test AUSD.
 *   3. Create a session authorization (server signer) on that wallet.
 *   4. Attach a policy (recipient allowlist + amount cap + expiry).
 *   5. Server sends a valid transfer within policy       -> must SUCCEED.
 *   6. Server sends to the wrong recipient                -> must FAIL.
 *   7. Server sends an over-limit amount                  -> must FAIL.
 *   8. Server sends after the policy's expiry              -> must FAIL.
 *   9. Revoke the session signer.
 *  10. Server attempts a transfer post-revocation          -> must FAIL.
 *
 * API surface used here (Node SDK `@privy-io/node`) was confirmed against
 * Privy's own docs during setup: PrivyClient({appId, appSecret}),
 * privy.wallets().create(), privy.wallets().update(),
 * privy.wallets().ethereum().sendTransaction(), privy.policies().create().
 * Two things were NOT directly confirmed in docs and are flagged inline
 * where used — verify against the installed package's TypeScript types if
 * they error:
 *   - the exact shape of `walletApi.authorizationPrivateKey` in the
 *     PrivyClient constructor options (needed to sign server-side updates
 *     to a wallet once it's owned by a key quorum), and
 *   - the calldata condition field name for the ERC-20 `transfer`
 *     recipient parameter (`transfer.recipient`), inferred from the
 *     confirmed `transfer.amount` example by the same method.paramName
 *     convention.
 *
 * Required env vars: see .env.example. This script does not run in CI —
 * it's a one-time architecture gate, run manually with `npm run privy:kill-test`.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";

const ERC20_ABI = parseAbi([
  "function transfer(address recipient, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const TRANSFER_ABI_JSON = [
  {
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const CHAIN_ID = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
const RPC_URL = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const AUSD_ADDRESS = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
const CAIP2 = `eip155:${CHAIN_ID}`;

interface StepResult {
  step: string;
  expected: "SUCCEED" | "FAIL";
  actual: "SUCCEED" | "FAIL" | "ERROR";
  detail?: string;
}

const results: StepResult[] = [];

function record(step: string, expected: "SUCCEED" | "FAIL", actual: "SUCCEED" | "FAIL" | "ERROR", detail?: string) {
  results.push({ step, expected, actual, detail });
  const pass = actual === expected;
  console.log(`${pass ? "✅" : "❌"} ${step} — expected ${expected}, got ${actual}${detail ? `: ${detail}` : ""}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const quorumId = requireEnv("PRIVY_AUTH_KEY_QUORUM_ID");
  const authorizationPrivateKey = requireEnv("PRIVY_AUTH_PRIVATE_KEY_PEM");
  const validRecipient = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const wrongRecipient = requireEnv("KILL_TEST_WRONG_RECIPIENT") as `0x${string}`;

  const privy = new PrivyClient({
    appId,
    appSecret,
    // NOT directly confirmed in docs for @privy-io/node — see file header.
    walletApi: { authorizationPrivateKey } as any,
  } as any);

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const decimals = await publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  const unit = (n: number) => BigInt(Math.round(n * 10 ** decimals));

  // --- Step 1: create the embedded wallet ---------------------------------
  console.log("\n[1/10] Creating Privy embedded wallet...");
  const wallet = await privy.wallets().create({ chain_type: "ethereum" });
  const walletId = (wallet as any).id as string;
  const walletAddress = (wallet as any).address as `0x${string}`;
  console.log(`  wallet id=${walletId} address=${walletAddress}`);

  // --- Step 2: fund with test AUSD ----------------------------------------
  console.log("\n[2/10] Fund this wallet with test AUSD, then press enter to continue.");
  console.log(`  Send test AUSD to: ${walletAddress}`);
  console.log(`  AUSD testnet contract: ${AUSD_ADDRESS}`);
  console.log(`  Faucet: ${process.env.AUSD_FAUCET_ADDRESS ?? "(see .env.example)"}`);
  await waitForBalance(publicClient, AUSD_ADDRESS, walletAddress, unit(1));

  // --- Step 3 + 4: create a policy and attach it as a session signer -----
  console.log("\n[3-4/10] Creating policy (allowlist + cap + expiry) and attaching session signer...");
  const cap = unit(10); // arbitrary small test cap
  const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes out
  const policy = await privy.policies().create({
    version: "1.0",
    name: "Taxis kill-test policy",
    chain_type: "ethereum",
    rules: [
      {
        name: "Allow AUSD transfer to valid recipient, under cap, before expiry",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: AUSD_ADDRESS },
          {
            field_source: "ethereum_calldata",
            field: "transfer.recipient", // see file header: inferred, not doc-confirmed
            abi: TRANSFER_ABI_JSON,
            operator: "eq",
            value: validRecipient,
          },
          {
            field_source: "ethereum_calldata",
            field: "transfer.amount",
            abi: TRANSFER_ABI_JSON,
            operator: "lte",
            value: `0x${cap.toString(16)}`,
          },
          { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: String(expiresAt) },
        ],
      },
    ],
  } as any);
  const policyId = (policy as any).id as string;
  console.log(`  policy id=${policyId}, expires ${new Date(expiresAt * 1000).toISOString()}`);

  await privy.wallets().update(walletId, {
    additional_signers: [{ signer_id: quorumId, override_policy_ids: [policyId] }],
  } as any);
  console.log("  session signer attached with policy.");

  const sendTransfer = async (to: `0x${string}`, amount: bigint) => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
    return privy
      .wallets()
      .ethereum()
      .sendTransaction(walletId, {
        caip2: CAIP2,
        params: { transaction: { to: AUSD_ADDRESS, data, chain_id: CHAIN_ID } },
      } as any);
  };

  // --- Step 5: valid transfer within policy -> must succeed --------------
  console.log("\n[5/10] Sending a valid transfer within policy...");
  try {
    const res = await sendTransfer(validRecipient, unit(1));
    record("Valid transfer within policy", "SUCCEED", "SUCCEED", (res as any).hash);
  } catch (err) {
    record("Valid transfer within policy", "SUCCEED", "FAIL", String(err));
  }

  // --- Step 6: wrong recipient -> must fail -------------------------------
  console.log("\n[6/10] Sending to the wrong recipient...");
  try {
    await sendTransfer(wrongRecipient, unit(1));
    record("Transfer to wrong recipient", "FAIL", "SUCCEED");
  } catch (err) {
    record("Transfer to wrong recipient", "FAIL", "FAIL", String(err));
  }

  // --- Step 7: over-limit amount -> must fail -----------------------------
  console.log("\n[7/10] Sending an over-limit amount...");
  try {
    await sendTransfer(validRecipient, cap + unit(1));
    record("Over-limit transfer", "FAIL", "SUCCEED");
  } catch (err) {
    record("Over-limit transfer", "FAIL", "FAIL", String(err));
  }

  // --- Step 8: after expiry -> must fail ----------------------------------
  console.log("\n[8/10] Creating an already-expired policy variant and testing it...");
  const expiredPolicy = await privy.policies().create({
    version: "1.0",
    name: "Taxis kill-test policy (pre-expired)",
    chain_type: "ethereum",
    rules: [
      {
        name: "Same as main rule but already past expiry",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: AUSD_ADDRESS },
          { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: String(Math.floor(Date.now() / 1000) - 60) },
        ],
      },
    ],
  } as any);
  await privy.wallets().update(walletId, {
    additional_signers: [{ signer_id: quorumId, override_policy_ids: [(expiredPolicy as any).id] }],
  } as any);
  try {
    await sendTransfer(validRecipient, unit(1));
    record("Transfer after policy expiry", "FAIL", "SUCCEED");
  } catch (err) {
    record("Transfer after policy expiry", "FAIL", "FAIL", String(err));
  }

  // Restore the valid, unexpired policy before the revocation test so step
  // 10's failure is attributable to revocation, not the expired policy.
  await privy.wallets().update(walletId, {
    additional_signers: [{ signer_id: quorumId, override_policy_ids: [policyId] }],
  } as any);

  // --- Step 9: revoke the session -----------------------------------------
  console.log("\n[9/10] Revoking the session signer...");
  await privy.wallets().update(walletId, { additional_signers: [] } as any);
  console.log("  session signer removed.");

  // --- Step 10: post-revocation transfer -> must fail ----------------------
  console.log("\n[10/10] Attempting a transfer post-revocation...");
  try {
    await sendTransfer(validRecipient, unit(1));
    record("Transfer post-revocation", "FAIL", "SUCCEED");
  } catch (err) {
    record("Transfer post-revocation", "FAIL", "FAIL", String(err));
  }

  console.log("\n--- Summary ---");
  const allPass = results.every((r) => r.actual === r.expected);
  for (const r of results) {
    console.log(`${r.actual === r.expected ? "PASS" : "FAIL"}  ${r.step}`);
  }
  console.log(allPass ? "\nAll gates passed. Custody architecture confirmed." : "\nSome gates failed — see above before building further on this architecture.");
  process.exit(allPass ? 0 : 1);
}

async function waitForBalance(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  owner: `0x${string}`,
  minAmount: bigint,
) {
  for (;;) {
    const bal = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
    if (bal >= minAmount) {
      console.log(`  funded: balance=${bal}`);
      return;
    }
    console.log("  waiting for funding... (checking every 5s)");
    await sleep(5000);
  }
}

main().catch((err) => {
  console.error("Kill-test script crashed:", err);
  process.exit(1);
});
