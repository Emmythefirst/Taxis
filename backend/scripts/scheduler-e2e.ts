/**
 * Scheduler end-to-end proof — the definitive version of
 * quote-engine-e2e.ts: instead of hand-building an envelope/recipient/cycle
 * inline, this seeds a real obligation into real persistence with a due
 * date genuinely in the past, then runs the actual scheduler
 * (generateDueCycles + runDueCycles) exactly as server.ts's
 * /cre/trigger-check would, and confirms a real cycle was generated,
 * executed for real on Monad testnet, and persisted correctly.
 *
 * Grant attachment still uses the OWNER quorum's key directly (test-harness
 * stand-in for the real client-side flow — see privy/policy.ts's header).
 * Everything downstream of that — cycle generation, quote signing,
 * execution, persistence — is exactly the real production code path.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { rmSync } from "node:fs";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createGrantPolicy } from "../src/privy/policy.js";
import { createPrivyTransferExecutor, checkTransactionReceipt } from "../src/privy/execute.js";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { getCycle } from "../src/persistence/cycles.js";
import { runDueCycles, staticMarketDataProvider } from "../src/scheduler/runDueCycles.js";
import { formatBaseUnitsToDecimal } from "../src/domain/units.js";
import type { ObligationEnvelope, Recipient } from "../src/domain/types.js";

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
  const ausdDecimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });
  const wallet = await privy.wallets().get(walletId);
  const walletAddress = (wallet as any).address as `0x${string}`;
  console.log(`AUSD decimals: ${ausdDecimals}, wallet address: ${walletAddress}`);

  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  console.log("\nCreating grant policy (recipient + cap + expiry)...");
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 120;
  const grant = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: validRecipient,
    maxAmountBaseUnits: 300_000_000n,
    expiresAtUnix,
    label: "Scheduler e2e grant",
  });
  console.log(`  policy id=${grant.policyId}`);
  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [grant.policyId] }],
  } as any);
  console.log("  attached to agent quorum.");

  // --- Seed a real obligation, due in the past, into a fresh DB ----------
  const dbPath = "./data/scheduler-e2e-demo.db";
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = openDb(dbPath);

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const anchorWeekday = eightDaysAgo.getUTCDay();

  insertUser(db, "user_demo");
  setUserWallet(db, "user_demo", walletId, walletAddress);
  const recipient: Recipient = {
    id: "rcp_demo",
    userId: "user_demo",
    label: "Demo recipient",
    payoutAddress: validRecipient,
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: eightDaysAgo.toISOString(),
  };
  insertRecipient(db, recipient);
  const obligation: ObligationEnvelope = {
    id: "obl_demo",
    userId: "user_demo",
    recipientId: "rcp_demo",
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd: 1000,
    // WEEKLY anchored to 8 days ago's weekday -> first due date is exactly
    // 8 days ago, genuinely in the past relative to "now" below.
    cadence: { kind: "WEEKLY", dayOfWeek: anchorWeekday },
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: eightDaysAgo.toISOString(),
  };
  insertObligation(db, obligation);
  console.log(`\nSeeded obligation ${obligation.id}, created ${obligation.createdAt} (due immediately).`);

  // --- Run the real scheduler, exactly as /cre/trigger-check would -------
  const executorFor = (resolvedWalletId: string) =>
    createPrivyTransferExecutor(privy, { walletId: resolvedWalletId, ausdAddress, chainId, agentPrivateKeyB64, publicClient });
  const getAvailableBalanceAusd = async (walletAddressArg: string) => {
    const balance = await publicClient.readContract({
      address: ausdAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddressArg as `0x${string}`],
    });
    return Number(formatBaseUnitsToDecimal(balance, ausdDecimals));
  };

  console.log("\nRunning the real scheduler (generateDueCycles + runDueCycles)...");
  const results = await runDueCycles({
    db,
    now: () => new Date(),
    market: staticMarketDataProvider(),
    quoteSigningPrivateKey,
    ausdDecimals,
    executorFor,
    getAvailableBalanceAusd,
    checkReceipt: (hash) => checkTransactionReceipt(publicClient, hash),
  });

  console.log(`\n${results.length} due cycle(s) processed:`);
  for (const r of results) {
    console.log(`  obligation=${r.obligationId} cycle=${r.cycleId} outcome=${r.outcome}`);
    if (r.outcome === "SETTLED") console.log(`    tx hash: ${(r.detail as any).txHash}`);
    if ("reason" in r.detail) console.log(`    reason: ${(r.detail as any).reason}`);
  }

  const persisted = getCycle(db, results[0]?.cycleId ?? "");
  console.log(`\nPersisted cycle state after run: ${persisted?.state ?? "(none found)"}`);

  const allSettled = results.length > 0 && results.every((r) => r.outcome === "SETTLED");
  console.log(allSettled ? "\n✅ Scheduler proven end-to-end on real Monad testnet." : "\n❌ Did not settle — see outcomes above.");
  process.exit(allSettled ? 0 : 1);
}

main().catch((err) => {
  console.error("Scheduler e2e script crashed:", err);
  process.exit(1);
});
