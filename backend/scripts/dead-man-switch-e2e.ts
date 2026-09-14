/**
 * Dead-man's-switch end-to-end proof — the final piece of the Section A.8
 * design: a real obligation, a genuinely inactive user, and a separate
 * CONTINUITY grant on a dedicated key quorum, all wired together through
 * the real scheduler (runDueCycles) to prove redirection actually happens
 * on live Monad testnet + Privy infra — not just in unit tests with fakes.
 *
 * This also validates the core architectural bet from progress.md: that
 * two independently-scoped grants (day-to-day CYCLE + separate CONTINUITY)
 * can coexist as two distinct `additional_signers` entries on the same
 * wallet, each enforced independently by Privy, with no need to guess at
 * undocumented AND/OR semantics for multiple policies stacked on one
 * signer — because we deliberately never do that.
 *
 * Grant attachment still uses the OWNER quorum's key directly (test-harness
 * stand-in for the real client-side flow, per privy/policy.ts's header).
 * Everything downstream — cycle generation, activity check, recipient
 * selection, quote signing, execution — is the real production code path.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { rmSync } from "node:fs";
import { ERC20_ABI } from "../src/privy/erc20.js";
import { createGrantPolicy } from "../src/privy/policy.js";
import { createPrivyTransferExecutor } from "../src/privy/execute.js";
import { openDb } from "../src/persistence/db.js";
import { insertUser, setUserWallet, touchUserActivity } from "../src/persistence/users.js";
import { insertRecipient } from "../src/persistence/recipients.js";
import { insertObligation } from "../src/persistence/obligations.js";
import { recordGrant } from "../src/persistence/grants.js";
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
  const continuityQuorumId = requireEnv("PRIVY_CONTINUITY_AGENT_KEY_QUORUM_ID");
  const continuityPrivateKeyB64 = requireEnv("PRIVY_CONTINUITY_AGENT_PRIVATE_KEY_B64");
  const quoteSigningPrivateKey = requireEnv("QUOTE_SIGNING_PRIVATE_KEY") as `0x${string}`;
  const primaryAddress = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const backupAddress = requireEnv("KILL_TEST_WRONG_RECIPIENT") as `0x${string}`; // reused here purely as a second distinct address
  const walletId = requireEnv("KILL_TEST_WALLET_ID");
  const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
  const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const inactivityThresholdDays = Number(process.env.DEAD_MAN_SWITCH_INACTIVITY_DAYS ?? "90");

  const ownerContext = { authorization_private_keys: [ownerPrivateKeyB64] };
  const privy = new PrivyClient({ appId, appSecret });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const ausdDecimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });
  const wallet = await privy.wallets().get(walletId);
  const walletAddress = (wallet as any).address as `0x${string}`;
  console.log(`AUSD decimals: ${ausdDecimals}, wallet: ${walletAddress}`);

  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  // --- Two separate policies, two separate signer entries ------------------
  console.log("\nCreating the day-to-day CYCLE policy (primary recipient)...");
  const cycleExpiresAtUnix = Math.floor(Date.now() / 1000) + 300;
  const cycleGrant = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: primaryAddress,
    maxAmountBaseUnits: 300_000_000n,
    expiresAtUnix: cycleExpiresAtUnix,
    label: "DMS demo cycle grant",
  });
  console.log(`  policy id=${cycleGrant.policyId}`);

  console.log("Creating the separate CONTINUITY policy (backup recipient)...");
  const continuityExpiresAtUnix = Math.floor(Date.now() / 1000) + 300;
  const continuityGrant = await createGrantPolicy(privy, {
    ausdAddress,
    recipientAddress: backupAddress,
    maxAmountBaseUnits: 300_000_000n,
    expiresAtUnix: continuityExpiresAtUnix,
    label: "DMS demo continuity grant",
  });
  console.log(`  policy id=${continuityGrant.policyId}`);

  console.log("\nAttaching BOTH as separate signer entries in one owner-signed update...");
  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [
      { signer_id: agentQuorumId, override_policy_ids: [cycleGrant.policyId] },
      { signer_id: continuityQuorumId, override_policy_ids: [continuityGrant.policyId] },
    ],
  } as any);
  console.log("  attached.");

  // --- Seed obligation + genuinely inactive user into a fresh DB ---------
  const dbPath = "./data/dms-e2e-demo.db";
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = openDb(dbPath);

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const wellPastThreshold = new Date(Date.now() - (inactivityThresholdDays + 30) * 24 * 60 * 60 * 1000);

  insertUser(db, "user_demo");
  setUserWallet(db, "user_demo", walletId, walletAddress);
  touchUserActivity(db, "user_demo", wellPastThreshold); // genuinely inactive
  console.log(`\nUser last active: ${wellPastThreshold.toISOString()} (${inactivityThresholdDays + 30} days ago > ${inactivityThresholdDays}-day threshold)`);

  const primaryRecipient: Recipient = {
    id: "rcp_primary",
    userId: "user_demo",
    label: "Primary",
    payoutAddress: primaryAddress,
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: eightDaysAgo.toISOString(),
  };
  const backupRecipient: Recipient = {
    id: "rcp_backup",
    userId: "user_demo",
    label: "Backup",
    payoutAddress: backupAddress,
    localCurrency: "NGN",
    status: "ACTIVE",
    addedAt: eightDaysAgo.toISOString(),
  };
  insertRecipient(db, primaryRecipient);
  insertRecipient(db, backupRecipient);

  const obligation: ObligationEnvelope = {
    id: "obl_demo",
    userId: "user_demo",
    recipientId: "rcp_primary",
    targetLocalAmount: 300_000,
    localCurrency: "NGN",
    maxAusdCost: 210,
    maxFeeAusd: 3,
    cumulativeCapAusd: 1000,
    cadence: { kind: "WEEKLY", dayOfWeek: eightDaysAgo.getUTCDay() }, // due immediately
    quoteExpirySeconds: 300,
    status: "ACTIVE",
    createdAt: eightDaysAgo.toISOString(),
    backupRecipientId: "rcp_backup",
  };
  insertObligation(db, obligation);

  recordGrant(db, { obligationId: "obl_demo", kind: "CYCLE", policyId: cycleGrant.policyId, agentQuorumId, expiresAt: new Date(cycleExpiresAtUnix * 1000).toISOString() });
  recordGrant(db, { obligationId: "obl_demo", kind: "CONTINUITY", policyId: continuityGrant.policyId, agentQuorumId: continuityQuorumId, expiresAt: new Date(continuityExpiresAtUnix * 1000).toISOString() });
  console.log(`Seeded obligation ${obligation.id} with backup recipient and both grants recorded.`);

  // --- Run the real scheduler with continuity configured -------------------
  const executorFor = (resolvedWalletId: string, kind: "CYCLE" | "CONTINUITY") =>
    createPrivyTransferExecutor(privy, {
      walletId: resolvedWalletId,
      ausdAddress,
      chainId,
      agentPrivateKeyB64: kind === "CONTINUITY" ? continuityPrivateKeyB64 : agentPrivateKeyB64,
      publicClient,
    });
  const getAvailableBalanceAusd = async (address: string) => {
    const balance = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [address as `0x${string}`] });
    return Number(formatBaseUnitsToDecimal(balance, ausdDecimals));
  };

  console.log("\nRunning the real scheduler with continuity redirection enabled...");
  const results = await runDueCycles({
    db,
    now: () => new Date(),
    market: staticMarketDataProvider(),
    quoteSigningPrivateKey,
    ausdDecimals,
    executorFor,
    getAvailableBalanceAusd,
    continuity: { inactivityThresholdDays },
  });

  console.log(`\n${results.length} due cycle(s) processed:`);
  for (const r of results) {
    const recipientAddress = "quote" in r.detail ? r.detail.quote.recipientAddress : "(none)";
    console.log(`  cycle=${r.cycleId} outcome=${r.outcome} paidTo=${recipientAddress}`);
    if (r.outcome === "SETTLED") console.log(`    tx hash: ${(r.detail as any).txHash}`);
  }

  const redirected = results.length > 0 && results.every((r) => r.outcome === "SETTLED" && "quote" in r.detail && r.detail.quote.recipientAddress.toLowerCase() === backupAddress.toLowerCase());
  console.log(
    redirected
      ? "\n✅ Dead-man's-switch redirection proven live: paid the BACKUP recipient via the separate continuity grant, on real Monad testnet."
      : "\n❌ Did not redirect to the backup recipient as expected — see outcomes above.",
  );
  process.exit(redirected ? 0 : 1);
}

main().catch((err) => {
  console.error("Dead-man's-switch e2e script crashed:", err);
  process.exit(1);
});
