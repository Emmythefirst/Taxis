/**
 * The trigger endpoint Chainlink CRE's cron workflow calls (progress.md
 * Section A.13/A.16). See scheduler/runDueCycles.ts's header for why it's
 * safe to let a 30s-interval CRE cron call this repeatedly, and for its
 * one remaining honest scope limitation (no real FX source).
 */

import type Database from "better-sqlite3";
import type { Router } from "../router.js";
import { sendJson } from "../respond.js";
import { listDueCycles } from "../../persistence/cycles.js";
import { runDueCycles, type RunDueCyclesDeps } from "../../scheduler/runDueCycles.js";

export function registerCreRoutes(router: Router, db: Database.Database, triggerSecret: string, execute?: RunDueCyclesDeps): void {
  router.post("/cre/trigger-check", async (ctx) => {
    const providedSecret = ctx.req.headers["x-cre-secret"];
    if (providedSecret !== triggerSecret) {
      sendJson(ctx.res, 401, { error: "invalid or missing x-cre-secret header" });
      return;
    }

    // Step 1 of the decision loop (Section A.10): a trigger firing is an
    // input to check, never proof a payment is due.
    const now = new Date().toISOString();

    if (execute) {
      try {
        const results = await runDueCycles(execute);
        sendJson(ctx.res, 200, {
          received: true,
          receivedAt: now,
          executed: true,
          results: results.map((r) => ({ obligationId: r.obligationId, cycleId: r.cycleId, outcome: r.outcome })),
        });
      } catch (err) {
        sendJson(ctx.res, 500, { error: "trigger processing failed", detail: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const due = listDueCycles(db, now);
    sendJson(ctx.res, 200, {
      received: true,
      receivedAt: now,
      executed: false,
      dueCycles: due.length,
      dueCycleIds: due.map((c) => c.id),
      note: "No live execution deps configured — due cycles are listed, not run. See server.ts header.",
    });
  });
}
