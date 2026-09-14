/**
 * Obligation creation and lifecycle. Obligation creation deliberately does
 * NOT need the owner's wallet id — creating a Privy policy is wallet-
 * agnostic (privy/policy.ts's header), and attaching it to the user's
 * wallet signer is an owner-gated, client-side action the frontend performs
 * with the `policyId` this returns. POST /obligations/:id/grant is called
 * once that live attach succeeds, to record it (bookkeeping only — see
 * persistence/grants.ts).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import type { Router } from "../router.js";
import { readJsonBody, sendJson } from "../respond.js";
import { userExists } from "../../persistence/users.js";
import { getRecipient } from "../../persistence/recipients.js";
import { getObligation, insertObligation, updateObligationStatus } from "../../persistence/obligations.js";
import { getCycle, listCyclesForObligation, saveCycle } from "../../persistence/cycles.js";
import { SqliteCapStore } from "../../persistence/sqliteCapStore.js";
import { approveCycle, skipCycle, type TransferExecutor } from "../../engine/quoteEngine.js";
import { getActiveGrant, listGrantsForObligation, recordGrant, retargetActiveGrantsPolicyId, revokeGrant, type GrantKind } from "../../persistence/grants.js";
import { getUser, touchUserActivity } from "../../persistence/users.js";
import { computeNextDueAt } from "../../domain/cadence.js";
import { parseDecimalToBaseUnits } from "../../domain/units.js";
import { rebuildOperationsPolicy } from "../../engine/operationsPolicy.js";
import type { Cadence, Hex, ObligationEnvelope } from "../../domain/types.js";

export interface ObligationsRouteDeps {
  db: Database.Database;
  /** Absent when this server was built without live Privy deps configured
   *  — guarded below (503) since creating a policy genuinely needs it. */
  privy?: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  /** Returned alongside the policy so the frontend's owner-signed
   *  `addSigners` call knows which quorum to attach — the same value
   *  server-side execution already uses. */
  agentQuorumId: string;
  /** Added on top of the obligation's own next-due-date to size the
   *  policy's expiry — see privy/policy.ts's header on why this is sized
   *  to one cycle, not the whole obligation's duration. */
  grantGraceSeconds: number;
  /** Resolves the real executor for a specific wallet — needed only by
   *  POST .../cycles/:cycleId/approve, which executes a real transfer.
   *  Absent in the same "not configured" cases as `privy` above. */
  executorFor?: (walletId: string, kind: GrantKind) => TransferExecutor;
}

export function registerObligationsRoutes(router: Router, deps: ObligationsRouteDeps): void {
  router.post("/users/:id/obligations", async (ctx) => {
    if (!deps.privy || !deps.agentQuorumId) {
      sendJson(ctx.res, 503, { error: "obligation creation not configured on this server (no Privy client)" });
      return;
    }
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }

    const body = await readJsonBody(ctx.req);
    const {
      recipientId,
      targetLocalAmount,
      localCurrency,
      maxAusdCost,
      maxFeeAusd,
      cumulativeCapAusd,
      cadence,
      quoteExpirySeconds,
    } = body as {
      recipientId?: string;
      targetLocalAmount?: number;
      localCurrency?: string;
      maxAusdCost?: number;
      maxFeeAusd?: number;
      cumulativeCapAusd?: number;
      cadence?: Cadence;
      quoteExpirySeconds?: number;
    };
    if (
      !recipientId ||
      typeof targetLocalAmount !== "number" ||
      !localCurrency ||
      typeof maxAusdCost !== "number" ||
      typeof maxFeeAusd !== "number" ||
      typeof cumulativeCapAusd !== "number" ||
      !cadence ||
      typeof quoteExpirySeconds !== "number"
    ) {
      sendJson(ctx.res, 400, {
        error:
          "expected { recipientId, targetLocalAmount, localCurrency, maxAusdCost, maxFeeAusd, cumulativeCapAusd, cadence, quoteExpirySeconds }",
      });
      return;
    }

    const recipient = getRecipient(deps.db, recipientId);
    if (!recipient || recipient.userId !== userId || recipient.status !== "ACTIVE") {
      sendJson(ctx.res, 400, { error: "recipientId must be an ACTIVE recipient belonging to this user" });
      return;
    }

    const obligation: ObligationEnvelope = {
      id: `obl_${randomUUID()}`,
      userId,
      recipientId,
      targetLocalAmount,
      localCurrency,
      maxAusdCost,
      maxFeeAusd,
      cumulativeCapAusd,
      cadence,
      quoteExpirySeconds,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    };
    insertObligation(deps.db, obligation);

    const firstDueAt = computeNextDueAt(cadence, null, new Date(obligation.createdAt));
    const expiresAtUnix = Math.floor(firstDueAt.getTime() / 1000) + deps.grantGraceSeconds;

    // Rebuilds the ONE combined policy the shared agent signer can hold —
    // this obligation's rule plus every other still-active grant/checkout
    // (see engine/operationsPolicy.ts's header for why a single-rule policy
    // per obligation is no longer possible).
    const { policyId } = await rebuildOperationsPolicy(
      { db: deps.db, privy: deps.privy, ausdAddress: deps.ausdAddress, ausdDecimals: deps.ausdDecimals },
      userId,
      {
        label: `Obligation ${obligation.id}`,
        recipientAddress: recipient.payoutAddress,
        maxAmountBaseUnits: parseDecimalToBaseUnits((maxAusdCost + maxFeeAusd).toFixed(6), deps.ausdDecimals),
        expiresAtUnix,
      },
    );

    sendJson(ctx.res, 200, { obligation, policyId, expiresAtUnix, agentQuorumId: deps.agentQuorumId });
  });

  router.get("/obligations/:id", (ctx) => {
    const obligation = getObligation(deps.db, ctx.params.id!);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    sendJson(ctx.res, 200, { obligation });
  });

  router.get("/obligations/:id/grants", (ctx) => {
    const obligation = getObligation(deps.db, ctx.params.id!);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    sendJson(ctx.res, 200, { grants: listGrantsForObligation(deps.db, obligation.id) });
  });

  router.get("/obligations/:id/cycles", (ctx) => {
    const obligation = getObligation(deps.db, ctx.params.id!);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    sendJson(ctx.res, 200, { cycles: listCyclesForObligation(deps.db, obligation.id) });
  });

  // Called once the frontend's live, owner-signed addSigners() attach for
  // POST /users/:id/obligations's (or /renew's) policyId succeeds — never
  // assumed. Recording a grant is also a valid proof-of-life signal for the
  // dead-man's-switch (Section A.8) — same as an explicit check-in.
  //
  // This is also the ONLY safe place to retarget every other active CYCLE
  // grant's recorded policy_id to this same policy: operationsPolicy.ts's
  // rebuildOperationsPolicy() deliberately does NOT do this itself (a
  // reviewer caught that it used to — creating the policy never guarantees
  // the owner-signed attach that follows actually happens; retargeting at
  // creation time would leave every OTHER obligation's bookkeeping pointing
  // at a policy that might never get attached at all, if the user backs out
  // of this exact tap).
  router.post("/obligations/:id/grant", async (ctx) => {
    const obligationId = ctx.params.id!;
    const obligation = getObligation(deps.db, obligationId);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    const body = await readJsonBody(ctx.req);
    const { policyId, expiresAtUnix, kind } = body as { policyId?: string; expiresAtUnix?: number; kind?: GrantKind };
    if (!policyId || typeof expiresAtUnix !== "number") {
      sendJson(ctx.res, 400, { error: "expected { policyId, expiresAtUnix, kind? }" });
      return;
    }
    const grantKind = kind ?? "CYCLE";
    const grant = recordGrant(deps.db, {
      obligationId,
      kind: grantKind,
      policyId,
      agentQuorumId: deps.agentQuorumId,
      expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
    });
    if (grantKind === "CYCLE") {
      retargetActiveGrantsPolicyId(deps.db, obligation.userId, "CYCLE", policyId, grant.id);
    }
    touchUserActivity(deps.db, obligation.userId);
    sendJson(ctx.res, 200, { grant });
  });

  // The user's real "Skip this cycle" tap on a REQUIRES_APPROVAL quote
  // (Section A.3/A.11) — releases that cycle's cumulative-cap reservation
  // and marks it SKIPPED. Never touches Privy: nothing was going to be
  // sent, so there's nothing to revoke.
  router.post("/obligations/:id/cycles/:cycleId/skip", (ctx) => {
    const cycle = getCycle(deps.db, ctx.params.cycleId!);
    if (!cycle || cycle.obligationId !== ctx.params.id) {
      sendJson(ctx.res, 404, { error: "cycle not found for this obligation" });
      return;
    }
    try {
      const skipped = skipCycle(cycle, { capStore: new SqliteCapStore(deps.db), now: () => new Date() });
      saveCycle(deps.db, skipped);
      sendJson(ctx.res, 200, { cycle: skipped });
    } catch (err) {
      sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The user's real "Approve anyway" tap on a REQUIRES_APPROVAL quote —
  // executes the EXACT already-shown quote (never regenerates one), same
  // real Privy transfer path runDueCycles uses for an AUTO_APPROVED cycle.
  router.post("/obligations/:id/cycles/:cycleId/approve", async (ctx) => {
    if (!deps.executorFor) {
      sendJson(ctx.res, 503, { error: "cycle approval not configured on this server (no live execution deps)" });
      return;
    }
    const cycle = getCycle(deps.db, ctx.params.cycleId!);
    if (!cycle || cycle.obligationId !== ctx.params.id) {
      sendJson(ctx.res, 404, { error: "cycle not found for this obligation" });
      return;
    }
    const obligation = getObligation(deps.db, cycle.obligationId);
    const owner = obligation ? getUser(deps.db, obligation.userId) : undefined;
    if (!owner?.walletId) {
      sendJson(ctx.res, 400, { error: "obligation owner has no wallet linked" });
      return;
    }
    try {
      const outcome = await approveCycle(cycle, {
        capStore: new SqliteCapStore(deps.db),
        now: () => new Date(),
        ausdDecimals: deps.ausdDecimals,
        executor: deps.executorFor(owner.walletId, "CYCLE"),
      });
      saveCycle(deps.db, outcome.cycle);
      sendJson(ctx.res, 200, outcome);
    } catch (err) {
      sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The user's real "renew" tap (Section A.4 step 6) — shortly before a
  // CYCLE grant's window lapses, this issues a fresh one sized the same way
  // as at creation (next due date + grace), never a mutation of the old
  // policy (Section A.6's hard rule). Reuses the exact same combined-policy
  // rebuild as creation, just with `excludingObligationId` so this
  // obligation's own soon-to-expire rule isn't ALSO pulled in from
  // persistence alongside the fresh one being attached.
  router.post("/obligations/:id/renew", async (ctx) => {
    if (!deps.privy || !deps.agentQuorumId) {
      sendJson(ctx.res, 503, { error: "renewal not configured on this server (no Privy client)" });
      return;
    }
    const obligationId = ctx.params.id!;
    const obligation = getObligation(deps.db, obligationId);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    const recipient = getRecipient(deps.db, obligation.recipientId);
    if (!recipient) {
      sendJson(ctx.res, 400, { error: "obligation's recipient no longer exists" });
      return;
    }

    const cycles = listCyclesForObligation(deps.db, obligationId);
    const lastDueAt = cycles.length > 0 ? new Date(cycles[cycles.length - 1]!.dueAt) : null;
    const nextDueAt = computeNextDueAt(obligation.cadence, lastDueAt, new Date(obligation.createdAt));
    const expiresAtUnix = Math.floor(nextDueAt.getTime() / 1000) + deps.grantGraceSeconds;

    const { policyId } = await rebuildOperationsPolicy(
      { db: deps.db, privy: deps.privy, ausdAddress: deps.ausdAddress, ausdDecimals: deps.ausdDecimals },
      obligation.userId,
      {
        label: `Obligation ${obligation.id}`,
        recipientAddress: recipient.payoutAddress,
        maxAmountBaseUnits: parseDecimalToBaseUnits((obligation.maxAusdCost + obligation.maxFeeAusd).toFixed(6), deps.ausdDecimals),
        expiresAtUnix,
      },
      obligationId,
    );

    sendJson(ctx.res, 200, { obligation, policyId, expiresAtUnix, agentQuorumId: deps.agentQuorumId });
  });

  // See server.ts's original header: the frontend must have ALREADY
  // performed the real, owner-signed revocation on Privy's side before
  // calling this; it only syncs Taxis's own records.
  router.post("/obligations/:id/kill-switch", (ctx) => {
    const obligationId = ctx.params.id!;
    const obligation = getObligation(deps.db, obligationId);
    if (!obligation) {
      sendJson(ctx.res, 404, { error: "obligation not found" });
      return;
    }
    if (ctx.req.headers["x-user-id"] !== obligation.userId) {
      sendJson(ctx.res, 403, { error: "x-user-id does not match this obligation's owner" });
      return;
    }

    const activeGrant = getActiveGrant(deps.db, obligationId, "CYCLE");
    if (activeGrant) {
      revokeGrant(deps.db, activeGrant.id);
    }
    updateObligationStatus(deps.db, obligationId, "PAUSED");

    sendJson(ctx.res, 200, {
      obligationId,
      revokedGrantId: activeGrant?.id ?? null,
      status: "PAUSED",
      note: activeGrant
        ? "Grant marked revoked. This assumes the frontend already performed the real owner-signed revocation on Privy."
        : "No active CYCLE grant found to revoke — obligation still paused.",
    });
  });
}
