/**
 * Recurring-policy spike — follow-up to privy-kill-test.ts.
 *
 * The original kill-test (Section A.16) proved the owner/agent-quorum
 * separation works. Investigating a follow-up question then surfaced a real
 * design conflict: Section 6 originally called for attaching a *fresh* Privy
 * policy every cycle, but updating a signer's policy requires the wallet
 * OWNER's live signature (confirmed via docs.privy.io) — and in the real
 * product the owner is the user's own key, not something Taxis holds. That
 * contradicts Section 4's "one tap, no further wallet interaction needed."
 *
 * Decision made in response (see progress.md Build Log): attach one durable
 * policy at grant time, sized to one cycle length plus a grace buffer, and
 * prompt the user for a one-tap renewal near expiry — rather than either (a)
 * a policy spanning the whole obligation (too weak: a compromised agent key
 * could pay the allowlisted recipient, under cap, for months) or (b) a fresh
 * policy every cycle (breaks zero-touch execution).
 *
 * This script empirically confirms three things about that decision before
 * the quote engine gets built on top of it:
 *
 *   1. A short-lived durable policy lets the agent execute multiple
 *      transactions inside its window without any further owner action.
 *   2. Privy's enclave does NOT block a second, identically-shaped
 *      transaction inside that same window — i.e. there is no on-chain
 *      duplicate-execution backstop once the policy stops being single-use.
 *      This confirms src/domain/reservation.ts's per-cycle uniqueness guard
 *      is load-bearing, not redundant.
 *   3. Owner-signed renewal (attaching a fresh policy after the old one
 *      expires) cleanly restores the agent's ability to execute — i.e. the
 *      "monthly tap" renewal UX is mechanically sound.
 *
 * Reuses the same wallet/owner/agent quorum setup as privy-kill-test.ts —
 * run that first (or just have KILL_TEST_WALLET_ID etc. already in .env).
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";

const ERC20_ABI = parseAbi([
  "function transfer(address recipient, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHAIN_ID = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
const RPC_URL = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const AUSD_ADDRESS = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
const CAIP2 = `eip155:${CHAIN_ID}`;

// Simulated "cycle length + grace buffer" — short here purely so the window
// boundary is observable within one script run. The real value would be
// sized to the obligation's cadence (e.g. ~35 days for a monthly plan).
const POLICY_WINDOW_SECONDS = 15;

interface CheckResult {
  name: string;
  expected: "SUCCEED" | "FAIL";
  actual: "SUCCEED" | "FAIL";
  detail?: string;
}
const results: CheckResult[] = [];
function record(name: string, expected: "SUCCEED" | "FAIL", actual: "SUCCEED" | "FAIL", detail?: string) {
  results.push({ name, expected, actual, detail });
  console.log(`${actual === expected ? "✅" : "❌"} ${name} — expected ${expected}, got ${actual}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const agentQuorumId = requireEnv("PRIVY_AGENT_KEY_QUORUM_ID");
  const ownerQuorumId = requireEnv("PRIVY_OWNER_KEY_QUORUM_ID");
  const agentPrivateKey = requireEnv("PRIVY_AGENT_PRIVATE_KEY_B64");
  const ownerPrivateKey = requireEnv("PRIVY_OWNER_PRIVATE_KEY_B64");
  const validRecipient = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const walletId = requireEnv("KILL_TEST_WALLET_ID");

  const agentContext = { authorization_private_keys: [agentPrivateKey] };
  const ownerContext = { authorization_private_keys: [ownerPrivateKey] };

  const privy = new PrivyClient({ appId, appSecret });
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const decimals = await publicClient.readContract({ address: AUSD_ADDRESS, abi: ERC20_ABI, functionName: "decimals" });
  const unit = (n: number) => BigInt(Math.round(n * 10 ** decimals));

  const wallet = await privy.wallets().get(walletId);
  const walletAddress = (wallet as any).address as `0x${string}`;
  console.log(`Using wallet id=${walletId} address=${walletAddress}`);
  // Owner is assumed already set by privy-kill-test.ts's first run. Set it
  // again defensively (idempotent) in case this script runs standalone —
  // once an owner exists, even re-setting it to the same value needs that
  // owner's own signature.
  await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);

  const cap = unit(10);

  async function attachPolicy(windowSeconds: number, label: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + windowSeconds;
    const policy = await privy.policies().create({
      version: "1.0",
      name: `Recurring spike ${label}`.slice(0, 49),
      chain_type: "ethereum",
      rules: [
        {
          name: "Allow AUSD, recipient+cap+expiry",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [
            { field_source: "ethereum_transaction", field: "to", operator: "eq", value: AUSD_ADDRESS },
            {
              field_source: "ethereum_calldata",
              field: "transfer.recipient",
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
    await privy.wallets().update(walletId, {
      authorization_context: ownerContext,
      additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [policyId] }],
    } as any);
    console.log(`  attached policy (${label}), expires ${new Date(expiresAt * 1000).toISOString()}`);
    return expiresAt;
  }

  const sendTransfer = async () => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [validRecipient, unit(1)] });
    return privy
      .wallets()
      .ethereum()
      .sendTransaction(walletId, {
        caip2: CAIP2,
        authorization_context: agentContext,
        params: { transaction: { to: AUSD_ADDRESS, data, chain_id: CHAIN_ID } },
      } as any);
  };

  // --- Step 1: attach the durable, short-window policy --------------------
  console.log(`\n[1] Attaching durable policy with a ${POLICY_WINDOW_SECONDS}s window (owner-signed)...`);
  const expiresAt = await attachPolicy(POLICY_WINDOW_SECONDS, "window A");

  // --- Step 2: "cycle 1" executes with no further owner action -----------
  console.log("\n[2] Cycle 1: agent executes with no owner action since grant...");
  try {
    const res = await sendTransfer();
    record("Cycle 1 executes zero-touch", "SUCCEED", "SUCCEED", (res as any).hash);
  } catch (err) {
    record("Cycle 1 executes zero-touch", "SUCCEED", "FAIL", String(err));
  }

  // --- Step 3: "cycle 2" — same shape, same still-valid window ------------
  console.log("\n[3] Cycle 2: identically-shaped transfer, same window, no new policy...");
  try {
    const res = await sendTransfer();
    record(
      "Privy allows a second identically-shaped tx in-window (expected — proves no on-chain dedup)",
      "SUCCEED",
      "SUCCEED",
      (res as any).hash,
    );
  } catch (err) {
    record("Privy allows a second identically-shaped tx in-window", "SUCCEED", "FAIL", String(err));
  }

  // --- Step 4: wait for the window to lapse, then attempt again -----------
  const waitMs = expiresAt * 1000 - Date.now() + 3000;
  console.log(`\n[4] Waiting ~${Math.round(waitMs / 1000)}s for the policy window to expire...`);
  await sleep(Math.max(waitMs, 0));
  try {
    await sendTransfer();
    record("Transfer after policy window expiry", "FAIL", "SUCCEED");
  } catch (err) {
    record("Transfer after policy window expiry", "FAIL", "FAIL", String(err).split("\n")[0]);
  }

  // --- Step 5: owner-signed renewal restores execution ---------------------
  console.log("\n[5] Renewing: owner re-authorizes a fresh policy window...");
  await attachPolicy(POLICY_WINDOW_SECONDS, "window B (renewal)");
  try {
    const res = await sendTransfer();
    record("Transfer succeeds again after renewal", "SUCCEED", "SUCCEED", (res as any).hash);
  } catch (err) {
    record("Transfer succeeds again after renewal", "SUCCEED", "FAIL", String(err));
  }

  console.log("\n--- Summary ---");
  const allPass = results.every((r) => r.actual === r.expected);
  for (const r of results) {
    console.log(`${r.actual === r.expected ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(
    allPass
      ? "\nAll checks passed. Periodic-re-consent design confirmed: zero-touch within a window, no on-chain dedup (reservation.ts's guard is load-bearing), renewal works."
      : "\nSome checks failed — see above before building the quote engine on this design.",
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Recurring-policy spike crashed:", err);
  process.exit(1);
});
