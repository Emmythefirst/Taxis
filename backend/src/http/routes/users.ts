/**
 * User lifecycle + the recipient/obligation lists scoped to one user.
 *
 * POST /users/sync is the piece that closes the wallet-id gap: called once
 * right after the frontend's real Privy login succeeds, with that user's
 * Privy user id. It resolves their embedded wallet server-side (never
 * trusting a client-supplied wallet id/address) and caches it on the user
 * row — see privy/walletLookup.ts and persistence/users.ts's setUserWallet.
 * Everything execution-side (runDueCycles, checkout) depends on this having
 * already run for a user before their obligations/checkouts can execute.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import type { PublicClient } from "viem";
import type { Router } from "../router.js";
import { readJsonBody, sendJson } from "../respond.js";
import { findWalletForPrivyUser } from "../../privy/walletLookup.js";
import { getUser, insertUser, setUserWallet, touchUserActivity, userExists } from "../../persistence/users.js";
import { insertRecipient, listRecipientsForUser } from "../../persistence/recipients.js";
import { listObligationsForUser } from "../../persistence/obligations.js";
import { listCheckoutsForUser } from "../../persistence/checkouts.js";
import { formatBaseUnitsToDecimal } from "../../domain/units.js";
import { ERC20_ABI } from "../../privy/erc20.js";
import type { Hex, Recipient } from "../../domain/types.js";

export interface UsersRouteDeps {
  db: Database.Database;
  /** Absent when this server was built without live Privy deps configured
   *  (tests, or PRIVY_APP_ID unset) — /users/sync still registers the user,
   *  just without wallet linkage. */
  privy?: PrivyClient;
  /** Omit to disable GET /users/:id/balance (503) — same "list-only until
   *  live deps exist" pattern as the rest of server.ts. */
  balance?: {
    ausdAddress: Hex;
    ausdDecimals: number;
    publicClient: PublicClient;
  };
}

export function registerUsersRoutes(router: Router, deps: UsersRouteDeps): void {
  router.post("/users/sync", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const { userId } = body as { userId?: string };
    if (!userId) {
      sendJson(ctx.res, 400, { error: "expected { userId }" });
      return;
    }

    insertUser(deps.db, userId); // idempotent — ON CONFLICT DO NOTHING
    touchUserActivity(deps.db, userId);

    // deps.privy is absent when this server was built without live Privy
    // deps configured (tests, or PRIVY_APP_ID unset) — register the user
    // anyway, just without wallet linkage, rather than a hard failure.
    const resolved = deps.privy ? await findWalletForPrivyUser(deps.privy, userId) : undefined;
    if (resolved) {
      setUserWallet(deps.db, userId, resolved.walletId, resolved.address);
    }

    const user = getUser(deps.db, userId)!;
    sendJson(ctx.res, 200, {
      userId: user.id,
      walletId: user.walletId,
      walletAddress: user.walletAddress,
      linked: user.walletId !== null,
    });
  });

  // Section A.8's client/backend split, made real. The frontend must have
  // ALREADY performed the real, owner-signed revocation on Privy's side
  // before calling this; this endpoint only syncs Taxis's own records.
  //
  // Auth here is a placeholder (x-user-id must match) standing in for real
  // session verification — same honest-gap pattern as CRE_TRIGGER_SECRET
  // being a shared secret. Do not treat this as sufficient for production.
  router.post("/users/:id/check-in", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    if (ctx.req.headers["x-user-id"] !== userId) {
      sendJson(ctx.res, 403, { error: "x-user-id does not match this user" });
      return;
    }
    const at = new Date();
    touchUserActivity(deps.db, userId, at);
    sendJson(ctx.res, 200, { userId, lastActiveAt: at.toISOString() });
  });

  router.get("/users/:id/balance", async (ctx) => {
    if (!deps.balance) {
      sendJson(ctx.res, 503, { error: "balance reading not configured on this server" });
      return;
    }
    const userId = ctx.params.id!;
    const user = getUser(deps.db, userId);
    if (!user) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    if (!user.walletAddress) {
      sendJson(ctx.res, 400, { error: "no wallet linked yet — call POST /users/sync first" });
      return;
    }
    const balance = await deps.balance.publicClient.readContract({
      address: deps.balance.ausdAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user.walletAddress as Hex],
    });
    sendJson(ctx.res, 200, { userId, ausdBalance: formatBaseUnitsToDecimal(balance, deps.balance.ausdDecimals) });
  });

  router.get("/users/:id/recipients", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    sendJson(ctx.res, 200, { recipients: listRecipientsForUser(deps.db, userId) });
  });

  router.post("/users/:id/recipients", async (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const body = await readJsonBody(ctx.req);
    const { label, payoutAddress, localCurrency } = body as { label?: string; payoutAddress?: Hex; localCurrency?: string };
    if (!label || !payoutAddress || !localCurrency) {
      sendJson(ctx.res, 400, { error: "expected { label, payoutAddress, localCurrency }" });
      return;
    }
    const recipient: Recipient = {
      id: `rcp_${randomUUID()}`,
      userId,
      label,
      payoutAddress,
      localCurrency,
      status: "ACTIVE",
      addedAt: new Date().toISOString(),
    };
    insertRecipient(deps.db, recipient);
    sendJson(ctx.res, 200, { recipient });
  });

  router.get("/users/:id/obligations", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    sendJson(ctx.res, 200, { obligations: listObligationsForUser(deps.db, userId) });
  });

  router.get("/users/:id/checkouts", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    sendJson(ctx.res, 200, { checkouts: listCheckoutsForUser(deps.db, userId) });
  });
}
