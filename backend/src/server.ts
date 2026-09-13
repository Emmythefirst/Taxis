/**
 * Minimal HTTP server exposing the trigger endpoint Chainlink CRE's cron
 * workflow calls (progress.md Section A.13/A.16 — CRE spike).
 *
 * When full live dependencies are configured (real Privy client, the demo
 * wallet, a market-data provider), a trigger genuinely runs every due cycle
 * through the real quote engine — real signed quote, real Privy execution,
 * real on-chain confirmation. See scheduler/runDueCycles.ts's header for
 * why this is safe to let a 30s-interval CRE cron call repeatedly (the
 * schedule itself gates execution, not this endpoint refusing to act) and
 * for the two honest scope limitations (no real FX source, one global demo
 * wallet) that still apply.
 *
 * Without those deps (e.g. in tests, or if PRIVY_APP_ID etc. aren't set),
 * the endpoint falls back to listing due cycles without executing anything
 * — still genuinely querying persistence, just not acting on the result.
 *
 * A shared-secret header (not a full auth scheme) is enough here: this
 * endpoint isn't reachable by an untrusted public client's browser, only by
 * the CRE workflow this project controls — see CRE_TRIGGER_SECRET.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { openDb } from "./persistence/db.js";
import { listDueCycles } from "./persistence/cycles.js";
import { runDueCycles, staticMarketDataProvider, type RunDueCyclesDeps } from "./scheduler/runDueCycles.js";
import { ERC20_ABI } from "./privy/erc20.js";
import { createPrivyTransferExecutor } from "./privy/execute.js";
import { formatBaseUnitsToDecimal } from "./domain/units.js";
import { getObligation, updateObligationStatus } from "./persistence/obligations.js";
import { getActiveGrant, revokeGrant } from "./persistence/grants.js";
import { touchUserActivity, userExists } from "./persistence/users.js";
import { createCheckout, executeCheckout } from "./engine/checkoutEngine.js";
import type { MarketDataProvider } from "./pricing/marketData.js";
import type { TransferExecutor } from "./engine/quoteEngine.js";
import type { Hex } from "./domain/types.js";
import { randomUUID } from "node:crypto";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export interface CheckoutServerDeps {
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  quoteSigningPrivateKey: Hex;
  executor: TransferExecutor;
  getAvailableBalanceAusd: () => Promise<number>;
  market: MarketDataProvider;
  /** Short window — minutes, not hours (Section A.3). */
  expirySeconds: number;
}

export interface CreateServerOptions {
  db?: Database.Database;
  /** When present, triggers genuinely execute due cycles. Omit to list-only. */
  execute?: RunDueCyclesDeps;
  /** When present, /checkout/* genuinely creates policies and executes. Omit to disable checkout entirely (503). */
  checkout?: CheckoutServerDeps;
}

export function createTaxisServer(options: CreateServerOptions = {}) {
  const triggerSecret = requireEnv("CRE_TRIGGER_SECRET");
  const db = options.db ?? openDb();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/cre/trigger-check") {
      const providedSecret = req.headers["x-cre-secret"];
      if (providedSecret !== triggerSecret) {
        sendJson(res, 401, { error: "invalid or missing x-cre-secret header" });
        return;
      }

      // Step 1 of the decision loop (Section A.10): a trigger firing is an
      // input to check, never proof a payment is due.
      const now = new Date().toISOString();

      if (options.execute) {
        runDueCycles(options.execute)
          .then((results) => {
            sendJson(res, 200, {
              received: true,
              receivedAt: now,
              executed: true,
              results: results.map((r) => ({ obligationId: r.obligationId, cycleId: r.cycleId, outcome: r.outcome })),
            });
          })
          .catch((err) => {
            sendJson(res, 500, { error: "trigger processing failed", detail: err instanceof Error ? err.message : String(err) });
          });
        return;
      }

      const due = listDueCycles(db, now);
      sendJson(res, 200, {
        received: true,
        receivedAt: now,
        executed: false,
        dueCycles: due.length,
        dueCycleIds: due.map((c) => c.id),
        note: "No live execution deps configured — due cycles are listed, not run. See server.ts header.",
      });
      return;
    }

    // POST /obligations/:id/kill-switch — Section A.8's client/backend
    // split, made real. The frontend must have ALREADY performed the real,
    // owner-signed revocation on Privy's side before calling this; this
    // endpoint only syncs Taxis's own records (marks the CYCLE grant
    // REVOKED, pauses the obligation) — it never touches Privy itself.
    //
    // Auth here is a placeholder (x-user-id must match the obligation's
    // owner) standing in for real session verification, which needs actual
    // Privy client-side login to exist first — same honest-gap pattern as
    // CRE_TRIGGER_SECRET being a shared secret rather than a full auth
    // scheme. Do not treat this as sufficient for production.
    const killSwitchMatch = req.method === "POST" && req.url?.match(/^\/obligations\/([^/]+)\/kill-switch$/);
    if (killSwitchMatch) {
      const obligationId = killSwitchMatch[1]!;
      const obligation = getObligation(db, obligationId);
      if (!obligation) {
        sendJson(res, 404, { error: "obligation not found" });
        return;
      }
      if (req.headers["x-user-id"] !== obligation.userId) {
        sendJson(res, 403, { error: "x-user-id does not match this obligation's owner" });
        return;
      }

      const activeGrant = getActiveGrant(db, obligationId, "CYCLE");
      if (activeGrant) {
        revokeGrant(db, activeGrant.id);
      }
      updateObligationStatus(db, obligationId, "PAUSED");

      sendJson(res, 200, {
        obligationId,
        revokedGrantId: activeGrant?.id ?? null,
        status: "PAUSED",
        note: activeGrant
          ? "Grant marked revoked. This assumes the frontend already performed the real owner-signed revocation on Privy."
          : "No active CYCLE grant found to revoke — obligation still paused.",
      });
      return;
    }

    // POST /users/:id/check-in — explicit proof-of-life for the dead-man's-
    // switch (Section A.8). Same auth placeholder caveat as above.
    const checkInMatch = req.method === "POST" && req.url?.match(/^\/users\/([^/]+)\/check-in$/);
    if (checkInMatch) {
      const userId = checkInMatch[1]!;
      if (!userExists(db, userId)) {
        sendJson(res, 404, { error: "user not found" });
        return;
      }
      if (req.headers["x-user-id"] !== userId) {
        sendJson(res, 403, { error: "x-user-id does not match this user" });
        return;
      }
      const at = new Date();
      touchUserActivity(db, userId, at);
      sendJson(res, 200, { userId, lastActiveAt: at.toISOString() });
      return;
    }

    // POST /checkout/quote — merchant checkout (Section A.2/A.6), a one-off
    // purchase quote + single-use Privy policy. See engine/checkoutEngine.ts.
    if (req.method === "POST" && req.url === "/checkout/quote") {
      if (!options.checkout) {
        sendJson(res, 503, { error: "checkout not configured on this server" });
        return;
      }
      const checkoutDeps = options.checkout;
      readJsonBody(req)
        .then(async (body) => {
          const { userId, merchantAddress, localAmount, localCurrency } = body as {
            userId?: string;
            merchantAddress?: Hex;
            localAmount?: number;
            localCurrency?: string;
          };
          if (!userId || !merchantAddress || typeof localAmount !== "number" || !localCurrency) {
            sendJson(res, 400, { error: "expected { userId, merchantAddress, localAmount, localCurrency }" });
            return;
          }
          if (!userExists(db, userId)) {
            sendJson(res, 404, { error: "user not found" });
            return;
          }

          const fees = checkoutDeps.market.getFees();
          const availableBalanceAusd = await checkoutDeps.getAvailableBalanceAusd();
          const result = await createCheckout(
            {
              db,
              privy: checkoutDeps.privy,
              now: () => new Date(),
              makeNonce: () => randomUUID(),
              quoteSigningPrivateKey: checkoutDeps.quoteSigningPrivateKey,
              ausdAddress: checkoutDeps.ausdAddress,
              ausdDecimals: checkoutDeps.ausdDecimals,
              fxRate: checkoutDeps.market.getFxRate(localCurrency),
              feeAgentAusd: fees.agentAusd,
              feeNetworkAusd: fees.networkAusd,
              availableBalanceAusd,
              expirySeconds: checkoutDeps.expirySeconds,
            },
            { userId, merchantAddress, localAmount, localCurrency },
          );
          sendJson(res, 200, result);
        })
        .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // POST /checkout/:id/execute — executes once the frontend confirms the
    // user's live, owner-signed approval attached the policy on Privy's side.
    const checkoutExecMatch = req.method === "POST" && req.url?.match(/^\/checkout\/([^/]+)\/execute$/);
    if (checkoutExecMatch) {
      if (!options.checkout) {
        sendJson(res, 503, { error: "checkout not configured on this server" });
        return;
      }
      const checkoutId = checkoutExecMatch[1]!;
      executeCheckout({ db, ausdDecimals: options.checkout.ausdDecimals, executor: options.checkout.executor }, checkoutId)
        .then((result) => sendJson(res, 200, result))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, message.includes("Unknown checkout") ? 404 : 400, { error: message });
        });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}

/**
 * Builds real execution deps from env vars (same wallet/keys used
 * throughout this project's spikes and scripts/quote-engine-e2e.ts).
 * Returns undefined — rather than throwing — if anything required is
 * missing, so the server can still start in list-only mode.
 */
async function tryBuildLiveExecutionDeps(): Promise<{ execute: RunDueCyclesDeps; checkout: CheckoutServerDeps } | undefined> {
  try {
    const appId = requireEnv("PRIVY_APP_ID");
    const appSecret = requireEnv("PRIVY_APP_SECRET");
    const agentPrivateKeyB64 = requireEnv("PRIVY_AGENT_PRIVATE_KEY_B64");
    const quoteSigningPrivateKey = requireEnv("QUOTE_SIGNING_PRIVATE_KEY") as `0x${string}`;
    const walletId = requireEnv("KILL_TEST_WALLET_ID");
    const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;
    const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
    const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

    const privy = new PrivyClient({ appId, appSecret });
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const wallet = await privy.wallets().get(walletId);
    const walletAddress = (wallet as any).address as `0x${string}`;
    const ausdDecimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });

    const executor = createPrivyTransferExecutor(privy, { walletId, ausdAddress, chainId, agentPrivateKeyB64, publicClient });
    const getAvailableBalanceAusd = async () => {
      const balance = await publicClient.readContract({
        address: ausdAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      });
      return Number(formatBaseUnitsToDecimal(balance, ausdDecimals));
    };

    // Dead-man's-switch continuity (Section A.8) — a SEPARATE, dedicated
    // key quorum, not the same agent key reused with a second policy (see
    // progress.md for why: undocumented AND/OR semantics for multiple
    // stacked policy ids on one signer). Entirely optional: if this
    // quorum hasn't been registered yet, continuity redirection is simply
    // disabled, not a startup failure.
    const continuityAgentPrivateKeyB64 = process.env.PRIVY_CONTINUITY_AGENT_PRIVATE_KEY_B64;
    const continuity = continuityAgentPrivateKeyB64
      ? {
          inactivityThresholdDays: Number(process.env.DEAD_MAN_SWITCH_INACTIVITY_DAYS ?? "90"),
          executor: createPrivyTransferExecutor(privy, {
            walletId,
            ausdAddress,
            chainId,
            agentPrivateKeyB64: continuityAgentPrivateKeyB64,
            publicClient,
          }),
        }
      : undefined;
    console.log(continuity ? "Continuity (dead-man's-switch) executor configured." : "Continuity not configured — PRIVY_CONTINUITY_AGENT_PRIVATE_KEY_B64 unset.");

    const market = staticMarketDataProvider();

    return {
      execute: {
        db: openDb(),
        continuity,
        now: () => new Date(),
        market,
        quoteSigningPrivateKey,
        ausdDecimals,
        executor,
        getAvailableBalanceAusd,
      },
      checkout: {
        privy,
        ausdAddress,
        ausdDecimals,
        quoteSigningPrivateKey,
        executor,
        getAvailableBalanceAusd,
        market,
        expirySeconds: Number(process.env.CHECKOUT_EXPIRY_SECONDS ?? "600"),
      },
    };
  } catch (err) {
    console.log(`Live execution not configured (${err instanceof Error ? err.message : err}) — triggers will list due cycles only, checkout disabled.`);
    return undefined;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? "8787");
  const live = await tryBuildLiveExecutionDeps();
  const server = createTaxisServer({ execute: live?.execute, checkout: live?.checkout });
  server.listen(port, () => {
    console.log(`Taxis backend listening on http://localhost:${port}`);
    console.log(`CRE trigger endpoint: POST http://localhost:${port}/cre/trigger-check`);
    console.log(live ? "Mode: LIVE execution (real Privy transfers on due cycles + checkout)." : "Mode: list-only (no live execution deps).");
  });
}
