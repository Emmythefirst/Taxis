/**
 * Builds the CONTINUITY quorum's single policy for a user (Section A.8) —
 * a dedicated signer, never shared with the day-to-day agent signer or
 * checkout (see privy/policy.ts's header), but still subject to the same
 * one-policy-per-signer constraint the multi-policy spike found. A user's
 * continuity setup applies uniformly to every currently-ACTIVE obligation
 * (one backup recipient, one inactivity threshold, matching the design's
 * single Settings-screen setting rather than a per-payment choice) — so
 * this always rebuilds ALL of them together, one rule per obligation, all
 * pointing at the same backup recipient.
 *
 * Unlike operationsPolicy.ts's rebuild (triggered by any grant/checkout
 * changing), this only ever runs when the user explicitly sets up or
 * changes continuity — a deliberate, distinct owner-signed step (Section
 * A.8's frontend implication), never folded into everyday obligation
 * creation.
 */

import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import { createCombinedPolicy, type GrantRuleParams } from "../privy/policy.js";
import { listActiveObligationsWithBackupForUser } from "../persistence/obligations.js";
import { parseDecimalToBaseUnits } from "../domain/units.js";
import type { Hex } from "../domain/types.js";

export interface ContinuityPolicyDeps {
  db: Database.Database;
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
}

export interface ContinuityRebuildResult {
  policyId: string;
  /** Every obligation now covered — the caller records one CONTINUITY grant row per id. */
  obligationIds: string[];
}

/**
 * Assumes the caller has ALREADY called `setBackupRecipient()` for every
 * obligation that should be covered (including newly-added ones) before
 * calling this — it only ever reads the obligations table's current state,
 * never decides which obligations opt in.
 */
export async function rebuildContinuityPolicy(deps: ContinuityPolicyDeps, userId: string, expiresAtUnix: number): Promise<ContinuityRebuildResult> {
  const covered = listActiveObligationsWithBackupForUser(deps.db, userId);

  const rules: GrantRuleParams[] = covered.map(
    (o): GrantRuleParams => ({
      ausdAddress: deps.ausdAddress,
      recipientAddress: o.backupRecipientAddress as Hex,
      maxAmountBaseUnits: parseDecimalToBaseUnits((o.maxAusdCost + o.maxFeeAusd).toFixed(6), deps.ausdDecimals),
      expiresAtUnix,
      label: `Continuity ${o.obligationId}`,
    }),
  );

  const { policyId } = await createCombinedPolicy(deps.privy, rules, `Taxis continuity — ${userId}`);
  return { policyId, obligationIds: covered.map((o) => o.obligationId) };
}
