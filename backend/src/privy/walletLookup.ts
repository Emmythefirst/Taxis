/**
 * Resolves a logged-in user's Privy-internal wallet id from their Privy
 * user id — the missing link execution code needs. The frontend's
 * `useWallets()` only exposes a wallet's `.address`; server-side calls like
 * `privy.wallets().ethereum().sendTransaction(walletId, ...)` need Privy's
 * internal `id` instead. `wallets().list({ user_id })` returns both on the
 * same object, which is all that's needed — no address-based lookup exists
 * or is required.
 *
 * Called once, right after login (see http/routes/users.ts's /users/sync),
 * and cached on the user row (persistence/users.ts's setUserWallet) rather
 * than re-resolved on every execution — Privy's user/wallet linkage doesn't
 * change without a new login.
 */

import type { PrivyClient } from "@privy-io/node";

export interface ResolvedWallet {
  walletId: string;
  address: string;
}

/**
 * Returns the user's first ethereum embedded wallet, or undefined if Privy
 * has none on record for this user yet (e.g. called before their embedded
 * wallet finished provisioning client-side).
 */
export async function findWalletForPrivyUser(privy: PrivyClient, privyUserId: string): Promise<ResolvedWallet | undefined> {
  const page = await privy.wallets().list({ user_id: privyUserId, chain_type: "ethereum" });
  const wallet = (page as any).data?.[0] ?? undefined;
  if (!wallet) return undefined;
  return { walletId: wallet.id as string, address: wallet.address as string };
}
