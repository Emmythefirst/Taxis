/**
 * Dead-man's-switch continuity setup (Section A.8) — deliberately its own
 * distinct authorization step, never a field on the day-to-day obligation
 * flow. Applies uniformly to every currently-ACTIVE obligation (one backup
 * recipient, one inactivity threshold per user, matching the design's
 * single Settings-screen setting) via the dedicated CONTINUITY quorum.
 *
 * Same two-step pattern as obligation creation: POST /continuity builds
 * the policy and returns it for the frontend's real owner-signed
 * `useSigners().addSigners()` attach (against the CONTINUITY quorum, not
 * the agent one); POST /continuity/grant is called once that attach
 * actually succeeds, to record it — never assumed to have happened.
 */

import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import type { Router } from "../router.js";
import { readJsonBody, sendJson } from "../respond.js";
import { userExists, setContinuityInactivityDays, touchUserActivity, getUser } from "../../persistence/users.js";
import { getRecipient } from "../../persistence/recipients.js";
import { listActiveObligationsWithBackupForUser, listObligationsForUser, setBackupRecipient } from "../../persistence/obligations.js";
import { recordGrant, getActiveGrant } from "../../persistence/grants.js";
import { rebuildContinuityPolicy } from "../../engine/continuityPolicy.js";
import type { Hex } from "../../domain/types.js";

export interface ContinuityRouteDeps {
  db: Database.Database;
  privy?: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
  /** Absent (continuity disabled entirely) unless PRIVY_CONTINUITY_AGENT_KEY_QUORUM_ID is set. */
  continuityQuorumId?: string;
  /** Sized independently of the short day-to-day CYCLE window — long-lived, renewed on its own cadence (Section A.8). */
  continuityGrantDurationSeconds: number;
}

export function registerContinuityRoutes(router: Router, deps: ContinuityRouteDeps): void {
  router.get("/users/:id/continuity", (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const covered = listActiveObligationsWithBackupForUser(deps.db, userId);
    const activeGrant = covered.length > 0 ? getActiveGrant(deps.db, covered[0]!.obligationId, "CONTINUITY") : undefined;
    if (!activeGrant) {
      sendJson(ctx.res, 200, { configured: false });
      return;
    }
    const obligations = listObligationsForUser(deps.db, userId);
    const backupRecipientId = obligations.find((o) => o.backupRecipientId)?.backupRecipientId;
    const user = getUser(deps.db, userId)!;
    sendJson(ctx.res, 200, {
      configured: true,
      backupRecipientId,
      inactivityThresholdDays: user.continuityInactivityDays,
      expiresAt: activeGrant.expiresAt,
    });
  });

  router.post("/users/:id/continuity", async (ctx) => {
    if (!deps.privy || !deps.continuityQuorumId) {
      sendJson(ctx.res, 503, { error: "continuity not configured on this server (no CONTINUITY quorum registered)" });
      return;
    }
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const body = await readJsonBody(ctx.req);
    const { backupRecipientId, inactivityThresholdDays } = body as { backupRecipientId?: string; inactivityThresholdDays?: number };
    if (!backupRecipientId || typeof inactivityThresholdDays !== "number" || inactivityThresholdDays <= 0) {
      sendJson(ctx.res, 400, { error: "expected { backupRecipientId, inactivityThresholdDays }" });
      return;
    }
    const backupRecipient = getRecipient(deps.db, backupRecipientId);
    if (!backupRecipient || backupRecipient.userId !== userId || backupRecipient.status !== "ACTIVE") {
      sendJson(ctx.res, 400, { error: "backupRecipientId must be an ACTIVE recipient belonging to this user" });
      return;
    }

    const activeObligations = listObligationsForUser(deps.db, userId).filter((o) => o.status === "ACTIVE");
    if (activeObligations.length === 0) {
      sendJson(ctx.res, 400, { error: "no active payments to protect yet — set up a payment first" });
      return;
    }
    for (const o of activeObligations) {
      setBackupRecipient(deps.db, o.id, backupRecipientId);
    }

    const expiresAtUnix = Math.floor(Date.now() / 1000) + deps.continuityGrantDurationSeconds;
    const { policyId, obligationIds } = await rebuildContinuityPolicy(
      { db: deps.db, privy: deps.privy, ausdAddress: deps.ausdAddress, ausdDecimals: deps.ausdDecimals },
      userId,
      expiresAtUnix,
    );

    sendJson(ctx.res, 200, { policyId, expiresAtUnix, continuityQuorumId: deps.continuityQuorumId, obligationIds });
  });

  // Called once the frontend's live, owner-signed addSigners() attach for
  // POST /users/:id/continuity's policyId succeeds — never assumed.
  router.post("/users/:id/continuity/grant", async (ctx) => {
    const userId = ctx.params.id!;
    if (!userExists(deps.db, userId)) {
      sendJson(ctx.res, 404, { error: "user not found" });
      return;
    }
    const body = await readJsonBody(ctx.req);
    const { policyId, expiresAtUnix, inactivityThresholdDays } = body as { policyId?: string; expiresAtUnix?: number; inactivityThresholdDays?: number };
    if (!policyId || typeof expiresAtUnix !== "number" || typeof inactivityThresholdDays !== "number") {
      sendJson(ctx.res, 400, { error: "expected { policyId, expiresAtUnix, inactivityThresholdDays }" });
      return;
    }

    const covered = listActiveObligationsWithBackupForUser(deps.db, userId);
    for (const o of covered) {
      recordGrant(deps.db, {
        obligationId: o.obligationId,
        kind: "CONTINUITY",
        policyId,
        agentQuorumId: deps.continuityQuorumId ?? "",
        expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
      });
    }
    setContinuityInactivityDays(deps.db, userId, inactivityThresholdDays);
    touchUserActivity(deps.db, userId); // setting this up is itself a proof-of-life signal

    sendJson(ctx.res, 200, { configured: true, obligationIds: covered.map((o) => o.obligationId) });
  });
}
