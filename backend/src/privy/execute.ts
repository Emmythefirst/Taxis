/**
 * Executes an already-approved cycle's AUSD transfer through the agent's
 * existing grant (progress.md Section A.6/A.9/A.10). Only ever signs with
 * the AGENT quorum's own key — this module must never be given or use an
 * owner key.
 *
 * Three distinct outcomes, not two — this matters for what's safe to do
 * with the cycle's cumulative-cap reservation afterward:
 *   1. The send itself throws (`policy_violation`, expired grant, no
 *      signer, etc.) — nothing was ever broadcast. This IS the enforcement
 *      working as designed. Safe to release the reservation and retry.
 *   2. The send succeeds and the resulting transaction is confirmed
 *      REVERTED on-chain — funds definitely did not move (an ERC-20
 *      revert rolls back the transfer entirely). Safe to release and retry.
 *   3. The send succeeds but no receipt is observed within the timeout —
 *      genuinely unknown. The transaction might still land later. Callers
 *      must NOT release the reservation or retry automatically here: doing
 *      so risks a double payment if the original transaction eventually
 *      confirms. This needs manual reconciliation, not a guess.
 *
 * checkTransactionReceipt() below is that reconciliation's one building
 * block — re-asking the same "confirmed? reverted?" question later for a
 * hash that's already broadcast, without re-sending anything. See
 * scheduler/reconcilePendingCycles.ts for the caller.
 */

import type { PrivyClient } from "@privy-io/node";
import { encodeFunctionData, type PublicClient } from "viem";
import type { Hex } from "../domain/types.js";
import { ERC20_ABI } from "./erc20.js";

export interface ExecuteTransferParams {
  walletId: string;
  ausdAddress: Hex;
  recipientAddress: Hex;
  amountBaseUnits: bigint;
  chainId: number;
  /** Base64 PKCS8 DER, no headers — see .env.example. */
  agentPrivateKeyB64: string;
  /** Used to wait for and inspect the transaction receipt after sending. */
  publicClient: PublicClient;
  /** How long to wait for a receipt before treating the outcome as unknown. */
  confirmationTimeoutMs?: number;
}

export interface ExecuteTransferResult {
  hash: string;
  /** True once a transaction receipt was actually observed on-chain. */
  confirmed: boolean;
  /** Only meaningful when `confirmed` is true. */
  reverted: boolean;
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;

export async function executeAusdTransfer(
  privy: PrivyClient,
  params: ExecuteTransferParams,
): Promise<ExecuteTransferResult> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [params.recipientAddress, params.amountBaseUnits],
  });
  const res = await privy
    .wallets()
    .ethereum()
    .sendTransaction(params.walletId, {
      caip2: `eip155:${params.chainId}`,
      authorization_context: { authorization_private_keys: [params.agentPrivateKeyB64] },
      params: { transaction: { to: params.ausdAddress, data, chain_id: params.chainId } },
    } as any);
  const hash = (res as any).hash as `0x${string}`;

  try {
    const receipt = await params.publicClient.waitForTransactionReceipt({
      hash,
      timeout: params.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS,
    });
    return { hash, confirmed: true, reverted: receipt.status === "reverted" };
  } catch {
    // Timed out, or the RPC couldn't locate/confirm it in time. Distinct
    // from a thrown send above: here, something WAS broadcast, so its
    // eventual fate is unknown, not negative — see file header.
    return { hash, confirmed: false, reverted: false };
  }
}

export interface ReceiptCheckResult {
  /** True once a transaction receipt was actually observed on-chain. */
  confirmed: boolean;
  /** Only meaningful when `confirmed` is true. */
  reverted: boolean;
}

/**
 * A single, non-blocking look — not another `waitForTransactionReceipt`
 * poll-with-timeout, since the caller (reconcilePendingCycles.ts) is itself
 * called repeatedly on a schedule and will simply look again next time if
 * this comes back unconfirmed. Any error (not found yet, or a transient RPC
 * hiccup) is treated as "still pending, not negative" — the same
 * conservative interpretation executeAusdTransfer()'s own catch block
 * already uses above, for the same reason: never misclassify a transient
 * failure as a real outcome.
 */
export async function checkTransactionReceipt(publicClient: PublicClient, hash: Hex): Promise<ReceiptCheckResult> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return { confirmed: true, reverted: receipt.status === "reverted" };
  } catch {
    return { confirmed: false, reverted: false };
  }
}

/**
 * Adapts executeAusdTransfer() to engine/quoteEngine.ts's TransferExecutor
 * port — the real (network-touching) implementation, as opposed to the
 * fakes used in tests.
 */
export function createPrivyTransferExecutor(
  privy: PrivyClient,
  fixed: Pick<
    ExecuteTransferParams,
    "walletId" | "ausdAddress" | "chainId" | "agentPrivateKeyB64" | "publicClient" | "confirmationTimeoutMs"
  >,
) {
  return {
    execute: (params: Pick<ExecuteTransferParams, "recipientAddress" | "amountBaseUnits">) =>
      executeAusdTransfer(privy, { ...fixed, ...params }),
  };
}
