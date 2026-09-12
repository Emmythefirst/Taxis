/**
 * One-off helper to pull test AUSD from Agora's Monad testnet faucet into a
 * Privy embedded wallet, instead of doing it manually through an explorer's
 * "write contract" UI.
 *
 * Confirmed contract interface (AgoraFaucet, verified source):
 *   function requestFunds(address _receiver) external
 * Callable by anyone, naming an arbitrary receiver — no msg.sender check.
 * Rate-limited by a global (not per-wallet) `maxDripFrequency` cooldown; the
 * live cooldown/drip-amount/max-balance values are read from chain below
 * rather than assumed, since Agora's docs don't publish Monad-specific
 * numbers.
 *
 * The call still costs gas in native MON, paid by the wallet executing it —
 * that wallet needs a small MON balance from Monad's native testnet faucet
 * before this script can succeed.
 *
 * Usage: npm run privy:fund-ausd
 *   Set KILL_TEST_WALLET_ID in .env to fund an existing wallet; otherwise
 *   this creates a new one and prints its id so you can save it.
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const FAUCET_ABI = parseAbi([
  "function requestFunds(address _receiver) external",
  "function faucetDripAmount() view returns (uint256)",
  "function maxAmountToOwn() view returns (uint256)",
  "function maxDripFrequency() view returns (uint256)",
  "function lastDripTimestamp() view returns (uint256)",
]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
  const faucetAddress = requireEnv("AUSD_FAUCET_ADDRESS") as `0x${string}`;
  const caip2 = `eip155:${chainId}`;

  // No authorization_context needed here: this call happens before any
  // policy/session-signer is attached to the wallet, so the app's own
  // credentials are sufficient (see scripts/privy-kill-test.ts for the case
  // where a quorum-owned additional signer requires one).
  const privy = new PrivyClient({ appId, appSecret });

  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  let walletId = process.env.KILL_TEST_WALLET_ID;
  let walletAddress: `0x${string}`;
  if (walletId) {
    const wallet = await privy.wallets().get(walletId);
    walletAddress = (wallet as any).address as `0x${string}`;
    console.log(`Reusing wallet id=${walletId} address=${walletAddress}`);
  } else {
    const wallet = await privy.wallets().create({ chain_type: "ethereum" });
    walletId = (wallet as any).id as string;
    walletAddress = (wallet as any).address as `0x${string}`;
    console.log(`Created wallet id=${walletId} address=${walletAddress}`);
    console.log("Save this as KILL_TEST_WALLET_ID in .env to reuse it (for this script and the kill-test).");
  }

  console.log("\nReading live faucet config from chain...");
  for (const fn of ["faucetDripAmount", "maxAmountToOwn", "maxDripFrequency", "lastDripTimestamp"] as const) {
    try {
      const val = await publicClient.readContract({ address: faucetAddress, abi: FAUCET_ABI, functionName: fn });
      console.log(`  ${fn}() = ${val}`);
    } catch (err) {
      console.log(`  ${fn}() unavailable: ${String(err).split("\n")[0]}`);
    }
  }

  const gasBalance = await publicClient.getBalance({ address: walletAddress });
  console.log(`\nNative MON balance: ${gasBalance} wei`);
  if (gasBalance === 0n) {
    console.log(
      "  WARNING: no native MON for gas. Fund this address from Monad's native testnet faucet first — the requestFunds call below will otherwise fail.",
    );
  }

  console.log("\nCalling requestFunds on the faucet...");
  const data = encodeFunctionData({ abi: FAUCET_ABI, functionName: "requestFunds", args: [walletAddress] });
  const res = await privy
    .wallets()
    .ethereum()
    .sendTransaction(walletId, {
      caip2,
      params: { transaction: { to: faucetAddress, data, chain_id: chainId } },
    } as any);
  console.log(`  sent: ${(res as any).hash ?? JSON.stringify(res)}`);

  console.log("\nWaiting for AUSD balance to reflect the drip...");
  const decimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });
  for (let i = 0; i < 12; i++) {
    try {
      const bal = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [walletAddress] });
      if (bal > 0n) {
        console.log(`  balance: ${bal} raw units (decimals=${decimals})`);
        return;
      }
    } catch (err) {
      console.log(`  balance check failed (will retry): ${String(err).split("\n")[0]}`);
    }
    await sleep(5000);
  }
  console.log("  still 0 after ~1 minute — check the tx hash on the explorer, it may still be pending.");
}

main().catch((err) => {
  console.error("Fund script failed:", err);
  process.exit(1);
});
