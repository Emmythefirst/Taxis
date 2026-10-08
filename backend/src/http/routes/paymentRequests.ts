/**
 * P2P "request money" routes (QR / link flow) — the reverse direction of
 * merchant Checkout (http/routes/checkout.ts): here the REQUESTER creates a
 * record asking to be paid before any payer is known, so creation has no
 * FX lock or balance check (there's no payer yet to check a balance for).
 * Those only happen once someone opens the request and pays it — at that
 * point /payment-requests/:id/pay reuses engine/checkoutEngine.ts's
 * createCheckout() UNCHANGED, with the requester's own wallet address
 * plugged in as the recipient, so it's the exact same signed-quote +
 * single-use-policy + real-execution path a merchant checkout uses. Execute
 * itself stays on the existing POST /checkout/:id/execute route — see that
 * route's handler for where a fulfilled request gets marked FULFILLED.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import type { PublicClient } from "viem";
import type { Router } from "../router.js";
import { readJsonBody, sendJson } from "../respond.js";
import { getUser, userExists } from "../../persistence/users.js";
import { insertPaymentRequest, getPaymentRequest, listPaymentRequestsForUser, updatePaymentRequestStatus } from "../../persistence/paymentRequests.js";
import { createCheckout } from "../../engine/checkoutEngine.js";
import { formatBaseUnitsToDecimal } from "../../domain/units.js";
import { ERC20_ABI } from "../../privy/erc20.js";
import type { MarketDataProvider } from "../../pricing/marketData.js";
import type { Hex } from "../../domain/types.js";

export interface PaymentRequestRouteDeps {
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  quoteSigningPrivateKey: Hex;
  agentQuorumId: string;
  publicClient: PublicClient;
  market: MarketDataProvider;
  /** Quote validity once a payer opens the request — same short window
   *  (minutes, not hours) as a merchant checkout's own quote expiry. */
  quoteExpirySeconds: number;
  /** How long the REQUEST ITSELF stays open if nobody pays it — unrelated
   *  to quoteExpirySeconds above, and typically much longer (hours/days),
   *  since a "pay me" link isn't FX-sensitive until someone actually opens
   *  it to pay. */
  requestExpirySeconds: number;
}

export function registerPaymentRequestRoutes(router: Router, db: Database.Database, deps: PaymentRequestRouteDeps): void {
  router.post("/payment-requests", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const { userId, localAmount, localCurrency, memo } = body as {
      userId?: string;
      localAmount?: number;
      localCurrency?: string;
      memo?: string;
    };
    if (!userId || typeof localAmount !== "number" || localAmount <= 0 || !localCurrency) {
      sendJson(ctx.res, 400, { error: "expected { userId, localAmount, localCurrency, memo? }" });
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

    const now = new Date();
    const request = insertPaymentRequest(db, {
      id: `preq_${randomUUID()}`,
      requesterUserId: userId,
      requesterAddress: user.walletAddress as Hex,
      localAmount,
      localCurrency,
      memo,
      expiresAt: new Date(now.getTime() + deps.requestExpirySeconds * 1000).toISOString(),
    });
    sendJson(ctx.res, 200, { request });
  });

  router.get("/payment-requests/:id", (ctx) => {
    const request = getPaymentRequest(db, ctx.params.id!);
    if (!request) {
      sendJson(ctx.res, 404, { error: "payment request not found" });
      return;
    }
    // Safe to return to anyone who has the link/QR — the same information
    // a merchant checkout screen already shows before any money moves, and
    // the real authorization still only happens via the payer's own
    // owner-signed tap in /pay below.
    sendJson(ctx.res, 200, { request });
  });

  router.get("/users/:id/payment-requests", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    sendJson(ctx.res, 200, { requests: listPaymentRequestsForUser(db, userId) });
  });

  router.post("/payment-requests/:id/cancel", async (ctx) => {
    const requestId = ctx.params.id!;
    const body = await readJsonBody(ctx.req);
    const { userId } = body as { userId?: string };
    const request = getPaymentRequest(db, requestId);
    if (!request) {
      sendJson(ctx.res, 404, { error: "payment request not found" });
      return;
    }
    if (request.requesterUserId !== userId) {
      sendJson(ctx.res, 403, { error: "only the requester can cancel this request" });
      return;
    }
    if (request.status !== "PENDING") {
      sendJson(ctx.res, 400, { error: `request is ${request.status}, not PENDING` });
      return;
    }
    updatePaymentRequestStatus(db, requestId, "CANCELLED");
    sendJson(ctx.res, 200, { requestId, status: "CANCELLED" });
  });

  router.post("/payment-requests/:id/pay", async (ctx) => {
    const requestId = ctx.params.id!;
    const body = await readJsonBody(ctx.req);
    const { userId } = body as { userId?: string };
    if (!userId) {
      sendJson(ctx.res, 400, { error: "expected { userId }" });
      return;
    }

    const request = getPaymentRequest(db, requestId);
    if (!request) {
      sendJson(ctx.res, 404, { error: "payment request not found" });
      return;
    }
    if (request.status !== "PENDING") {
      sendJson(ctx.res, 400, { error: `request is ${request.status}, not PENDING` });
      return;
    }
    if (new Date(request.expiresAt).getTime() <= Date.now()) {
      updatePaymentRequestStatus(db, requestId, "EXPIRED");
      sendJson(ctx.res, 400, { error: "request has expired" });
      return;
    }
    if (!userExists(db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const payer = getUser(db, userId)!;
    if (!payer.walletAddress) {
      sendJson(ctx.res, 400, { error: "no wallet linked yet — call POST /users/sync first" });
      return;
    }
    if (payer.id === request.requesterUserId) {
      sendJson(ctx.res, 400, { error: "cannot pay your own payment request" });
      return;
    }

    const balanceBaseUnits = await deps.publicClient.readContract({
      address: deps.ausdAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [payer.walletAddress as Hex],
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
        fxRate: deps.market.getFxRate(request.localCurrency),
        feeAgentAusd: fees.agentAusd,
        feeNetworkAusd: fees.networkAusd,
        availableBalanceAusd,
        expirySeconds: deps.quoteExpirySeconds,
      },
      {
        userId,
        merchantAddress: request.requesterAddress,
        localAmount: request.localAmount,
        localCurrency: request.localCurrency,
        paymentRequestId: requestId,
      },
    );
    sendJson(ctx.res, 200, result.outcome === "QUOTED" ? { ...result, agentQuorumId: deps.agentQuorumId, request } : result);
  });
}
