/**
 * Taxis backend HTTP server. Routes are split into http/routes/*.ts modules
 * dispatched through http/router.ts's Router — see that file's header for
 * why a plain if-chain stopped being the right shape once the route count
 * grew past the original CRE-trigger-only spike.
 *
 * When full live dependencies are configured (real Privy client, a
 * market-data provider), triggers and checkouts genuinely execute through
 * the real quote engine — real signed quote, real Privy execution, real
 * on-chain confirmation, resolved against each user's OWN wallet (see
 * privy/walletLookup.ts and http/routes/users.ts's /users/sync) rather than
 * one hardcoded demo wallet. Without those deps (e.g. in tests, or if
 * PRIVY_APP_ID etc. aren't set), CRE triggers fall back to listing due
 * cycles without executing, and checkout/balance routes are disabled (503).
 *
 * CRE_TRIGGER_SECRET is a shared-secret header, not a full auth scheme —
 * acceptable because this endpoint is only ever called by the CRE workflow
 * this project controls, not an untrusted public client.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http, type PublicClient } from "viem";
import { Router } from "./http/router.js";
import { sendJson } from "./http/respond.js";
import { openDb } from "./persistence/db.js";
import { registerUsersRoutes, type UsersRouteDeps } from "./http/routes/users.js";
import { registerObligationsRoutes, type ObligationsRouteDeps } from "./http/routes/obligations.js";
import { registerCheckoutRoutes, type CheckoutRouteDeps } from "./http/routes/checkout.js";
import { registerContinuityRoutes, type ContinuityRouteDeps } from "./http/routes/continuity.js";
import { registerCreRoutes } from "./http/routes/cre.js";
import { staticMarketDataProvider, type RunDueCyclesDeps } from "./scheduler/runDueCycles.js";
import { ERC20_ABI } from "./privy/erc20.js";
import { createPrivyTransferExecutor, checkTransactionReceipt } from "./privy/execute.js";
import { formatBaseUnitsToDecimal } from "./domain/units.js";
import type { Hex } from "./domain/types.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id, x-cre-secret");
}

export interface CreateServerOptions {
  db?: Database.Database;
  privy?: PrivyClient;
  ausdAddress?: Hex;
  ausdDecimals?: number;
  agentQuorumId?: string;
  grantGraceSeconds?: number;
  /** When present, CRE triggers genuinely execute due cycles. Omit to list-only. */
  execute?: RunDueCyclesDeps;
  /** When present, /checkout/* and /users/:id/balance are live. Omit to disable (503). */
  checkout?: CheckoutRouteDeps;
  /** When present, /users/:id/continuity* are live. Omit to disable (503) — the CONTINUITY quorum is optional infra (see .env.example). */
  continuity?: ContinuityRouteDeps;
}

export function createTaxisServer(options: CreateServerOptions = {}) {
  const triggerSecret = requireEnv("CRE_TRIGGER_SECRET");
  const db = options.db ?? openDb();
  const router = new Router();

  // A server with no live Privy client at all (most unit tests) still needs
  // *some* client object for routes that require one in their deps type —
  // those routes are simply never reachable in that mode because `execute`/
  // `checkout` (which is what actually gates whether obligations/checkout
  // routes do anything live) are absent too. Obligation creation always
  // needs a real `privy` to create policies, so tests that exercise it pass
  // one explicitly via `options.privy`.
  if (options.privy && options.ausdAddress !== undefined && options.ausdDecimals !== undefined && options.agentQuorumId) {
    const usersDeps: UsersRouteDeps = {
      db,
      privy: options.privy,
      balance: options.checkout
        ? { ausdAddress: options.checkout.ausdAddress, ausdDecimals: options.checkout.ausdDecimals, publicClient: options.checkout.publicClient }
        : undefined,
    };
    registerUsersRoutes(router, usersDeps);

    const obligationsDeps: ObligationsRouteDeps = {
      db,
      privy: options.privy,
      ausdAddress: options.ausdAddress,
      ausdDecimals: options.ausdDecimals,
      agentQuorumId: options.agentQuorumId,
      grantGraceSeconds: options.grantGraceSeconds ?? 3 * 24 * 60 * 60,
      executorFor: options.execute?.executorFor,
    };
    registerObligationsRoutes(router, obligationsDeps);
  } else {
    // Still register the parts of /users/* and /obligations/* that don't
    // need Privy (sync-without-linking, check-in, recipients, obligation
    // listing, kill-switch) — creation itself 503s via the guard above.
    registerUsersRoutes(router, { db, balance: undefined });
    registerObligationsRoutes(router, {
      db,
      ausdAddress: "0x0000000000000000000000000000000000dEaD",
      ausdDecimals: 6,
      agentQuorumId: "",
      grantGraceSeconds: 0,
    });
  }

  if (options.checkout) {
    registerCheckoutRoutes(router, db, options.checkout);
  } else {
    router.post("/checkout/quote", (ctx) => sendJson(ctx.res, 503, { error: "checkout not configured on this server" }));
    router.post("/checkout/:id/execute", (ctx) => sendJson(ctx.res, 503, { error: "checkout not configured on this server" }));
  }

  if (options.continuity) {
    registerContinuityRoutes(router, options.continuity);
  } else {
    router.get("/users/:id/continuity", (ctx) => sendJson(ctx.res, 200, { configured: false }));
    router.post("/users/:id/continuity", (ctx) => sendJson(ctx.res, 503, { error: "continuity not configured on this server" }));
    router.post("/users/:id/continuity/grant", (ctx) => sendJson(ctx.res, 503, { error: "continuity not configured on this server" }));
  }

  registerCreRoutes(router, db, triggerSecret, options.execute);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const handled = await router.handle(req, res);
    if (!handled) {
      sendJson(res, 404, { error: "not found" });
    }
  });
}

/**
 * Builds real execution deps from env vars. Returns undefined — rather than
 * throwing — if anything required is missing, so the server can still
 * start in list-only mode.
 */
async function tryBuildLiveExecutionDeps(): Promise<{
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  agentQuorumId: string;
  execute: RunDueCyclesDeps;
  checkout: CheckoutRouteDeps;
  continuity?: ContinuityRouteDeps;
} | undefined> {
  try {
    const appId = requireEnv("PRIVY_APP_ID");
    const appSecret = requireEnv("PRIVY_APP_SECRET");
    const agentQuorumId = requireEnv("PRIVY_AGENT_KEY_QUORUM_ID");
    const agentPrivateKeyB64 = requireEnv("PRIVY_AGENT_PRIVATE_KEY_B64");
    const quoteSigningPrivateKey = requireEnv("QUOTE_SIGNING_PRIVATE_KEY") as Hex;
    const ausdAddress = requireEnv("AUSD_TESTNET_ADDRESS") as Hex;
    const chainId = Number(process.env.MONAD_TESTNET_CHAIN_ID ?? "10143");
    const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

    const privy = new PrivyClient({ appId, appSecret });
    const publicClient: PublicClient = createPublicClient({ transport: http(rpcUrl) });
    const ausdDecimals = await publicClient.readContract({ address: ausdAddress, abi: ERC20_ABI, functionName: "decimals" });

    // Dead-man's-switch continuity (Section A.8) — a SEPARATE, dedicated
    // key quorum, not the same agent key reused with a second policy (see
    // progress.md for why). Entirely optional: if this quorum hasn't been
    // registered yet, continuity redirection is simply disabled.
    const continuityAgentPrivateKeyB64 = process.env.PRIVY_CONTINUITY_AGENT_PRIVATE_KEY_B64;
    const continuityQuorumId = process.env.PRIVY_CONTINUITY_AGENT_KEY_QUORUM_ID;
    console.log(
      continuityAgentPrivateKeyB64 && continuityQuorumId
        ? "Continuity (dead-man's-switch) executor configured."
        : "Continuity not configured — PRIVY_CONTINUITY_AGENT_PRIVATE_KEY_B64/PRIVY_CONTINUITY_AGENT_KEY_QUORUM_ID unset.",
    );

    const executorFor = (walletId: string, kind: "CYCLE" | "CONTINUITY") =>
      createPrivyTransferExecutor(privy, {
        walletId,
        ausdAddress,
        chainId,
        agentPrivateKeyB64: kind === "CONTINUITY" && continuityAgentPrivateKeyB64 ? continuityAgentPrivateKeyB64 : agentPrivateKeyB64,
        publicClient,
      });
    const getAvailableBalanceAusd = async (walletAddress: string) => {
      const balance = await publicClient.readContract({
        address: ausdAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Hex],
      });
      return Number(formatBaseUnitsToDecimal(balance, ausdDecimals));
    };

    const market = staticMarketDataProvider();

    return {
      privy,
      ausdAddress,
      ausdDecimals,
      agentQuorumId,
      execute: {
        db: openDb(),
        continuity: continuityAgentPrivateKeyB64
          ? { inactivityThresholdDays: Number(process.env.DEAD_MAN_SWITCH_INACTIVITY_DAYS ?? "90") }
          : undefined,
        now: () => new Date(),
        market,
        quoteSigningPrivateKey,
        ausdDecimals,
        executorFor,
        getAvailableBalanceAusd,
        checkReceipt: (hash) => checkTransactionReceipt(publicClient, hash),
      },
      checkout: {
        privy,
        ausdAddress,
        ausdDecimals,
        quoteSigningPrivateKey,
        chainId,
        agentPrivateKeyB64,
        agentQuorumId,
        publicClient,
        market,
        expirySeconds: Number(process.env.CHECKOUT_EXPIRY_SECONDS ?? "600"),
      },
      continuity:
        continuityAgentPrivateKeyB64 && continuityQuorumId
          ? {
              db: openDb(),
              privy,
              ausdAddress,
              ausdDecimals,
              continuityQuorumId,
              continuityGrantDurationSeconds: Number(process.env.CONTINUITY_GRANT_DURATION_SECONDS ?? String(180 * 24 * 60 * 60)),
            }
          : undefined,
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
  const server = createTaxisServer({
    privy: live?.privy,
    ausdAddress: live?.ausdAddress,
    ausdDecimals: live?.ausdDecimals,
    agentQuorumId: live?.agentQuorumId,
    execute: live?.execute,
    checkout: live?.checkout,
    continuity: live?.continuity,
  });
  server.listen(port, () => {
    console.log(`Taxis backend listening on http://localhost:${port}`);
    console.log(`CRE trigger endpoint: POST http://localhost:${port}/cre/trigger-check`);
    console.log(live ? "Mode: LIVE execution (real Privy transfers on due cycles + checkout)." : "Mode: list-only (no live execution deps).");
  });
}
