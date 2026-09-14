/**
 * Merchant checkout HTTP routes (Section A.2/A.6). Resolves the requesting
 * user's own wallet per-request (via persistence/users.ts, populated by
 * /users/sync) rather than a single global demo wallet — see
 * scheduler/runDueCycles.ts's header for the same fix on the recurring
 * side. engine/checkoutEngine.ts itself is unchanged: it already took
 * `availableBalanceAusd`/`executor` as plain per-call values, so this
 * module just has to compute those from the right wallet before calling in.
 */

import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import type { PublicClient } from "viem";
import type { Router } from "../router.js";
import { readJsonBody, sendJson } from "../respond.js";
import { getUser, userExists } from "../../persistence/users.js";
import { createCheckout, executeCheckout } from "../../engine/checkoutEngine.js";
import { createPrivyTransferExecutor } from "../../privy/execute.js";
import { formatBaseUnitsToDecimal } from "../../domain/units.js";
import { ERC20_ABI } from "../../privy/erc20.js";
import { getCheckout, getCheckoutPolicyId } from "../../persistence/checkouts.js";
import { retargetActiveGrantsPolicyId } from "../../persistence/grants.js";
import type { MarketDataProvider } from "../../pricing/marketData.js";
import type { Hex } from "../../domain/types.js";
import { randomUUID } from "node:crypto";

export interface CheckoutRouteDeps {
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  quoteSigningPrivateKey: Hex;
  chainId: number;
  agentPrivateKeyB64: string;
  /** Returned alongside the policy so the frontend's owner-signed
   *  `addSigners` call knows which quorum to attach — checkout shares the
   *  same shared agent signer as recurring obligations (see
   *  engine/operationsPolicy.ts's header). */
  agentQuorumId: string;
  publicClient: PublicClient;
  market: MarketDataProvider;
  /** Short window — minutes, not hours (Section A.3). */
  expirySeconds: number;
}

export function registerCheckoutRoutes(router: Router, db: Database.Database, deps: CheckoutRouteDeps): void {
  router.post("/checkout/quote", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const { userId, merchantAddress, localAmount, localCurrency } = body as {
      userId?: string;
      merchantAddress?: Hex;
      localAmount?: number;
      localCurrency?: string;
    };
    if (!userId || !merchantAddress || typeof localAmount !== "number" || !localCurrency) {
      sendJson(ctx.res, 400, { error: "expected { userId, merchantAddress, localAmount, localCurrency }" });
      return;
    }
    if (!userExists(db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const user = getUser(db, userId)!;
    if (!user.walletAddress) {
      sendJson(ctx.res, 400, { error: "no wallet linked yet — call POST /users/sync first" });
      return;
    }

    const balanceBaseUnits = await deps.publicClient.readContract({
      address: deps.ausdAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user.walletAddress as Hex],
    });
    const availableBalanceAusd = Number(formatBaseUnitsToDecimal(balanceBaseUnits, deps.ausdDecimals));
    const fees = deps.market.getFees();

    const result = await createCheckout(
      {
        db,
        privy: deps.privy,
        now: () => new Date(),
        makeNonce: () => randomUUID(),
        quoteSigningPrivateKey: deps.quoteSigningPrivateKey,
        ausdAddress: deps.ausdAddress,
        ausdDecimals: deps.ausdDecimals,
        fxRate: deps.market.getFxRate(localCurrency),
        feeAgentAusd: fees.agentAusd,
        feeNetworkAusd: fees.networkAusd,
        availableBalanceAusd,
        expirySeconds: deps.expirySeconds,
      },
      { userId, merchantAddress, localAmount, localCurrency },
    );
    sendJson(ctx.res, 200, result.outcome === "QUOTED" ? { ...result, agentQuorumId: deps.agentQuorumId } : result);
  });

  router.post("/checkout/:id/execute", async (ctx) => {
    const checkoutId = ctx.params.id!;
    const checkout = getCheckout(db, checkoutId);
    if (!checkout) {
      sendJson(ctx.res, 404, { error: "checkout not found" });
      return;
    }
    const owner = getUser(db, checkout.userId);
    if (!owner?.walletId) {
      sendJson(ctx.res, 400, { error: "checkout owner has no wallet linked" });
      return;
    }
    const executor = createPrivyTransferExecutor(deps.privy, {
      walletId: owner.walletId,
      ausdAddress: deps.ausdAddress,
      chainId: deps.chainId,
      agentPrivateKeyB64: deps.agentPrivateKeyB64,
      publicClient: deps.publicClient,
    });

    try {
      const result = await executeCheckout({ db, ausdDecimals: deps.ausdDecimals, executor }, checkoutId);
      // Retargeting every other active CYCLE grant's recorded policy_id to
      // this checkout's policy is only safe once we have PROOF this exact
      // policy was actually live on the wallet — a signer that never
      // accepted the attach would have rejected the send entirely (see
      // engine/checkoutEngine.ts's FAILED path), not produced SETTLED or
      // PENDING_CONFIRMATION. Trusting "the frontend called this endpoint"
      // alone isn't enough (a buggy/malicious client could call it without
      // ever attaching) — this is stronger than that, not just simpler.
      if (result.outcome === "SETTLED" || result.outcome === "PENDING_CONFIRMATION") {
        const policyId = getCheckoutPolicyId(db, checkoutId);
        if (policyId) retargetActiveGrantsPolicyId(db, checkout.userId, "CYCLE", policyId);
      }
      sendJson(ctx.res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ctx.res, message.includes("Unknown checkout") ? 404 : 400, { error: message });
    }
  });
}
