/**
 * Rebuilds the ONE shared Privy policy that the AGENT quorum's signer holds
 * for a given user — the fix for the gap a spike found (progress.md,
 * 2026-09-13): a signer can hold exactly one policy at a time, so every
 * recurring obligation's CYCLE grant AND every in-flight merchant checkout
 * (both attach to the same shared agent signer — checkout has no quorum of
 * its own) must live as separate RULES inside that single policy, not as
 * separate policies. The CONTINUITY quorum is unaffected: it's a dedicated
 * signer per user that only ever holds one grant, so privy/policy.ts's
 * single-rule `createGrantPolicy()` remains correct for it.
 *
 * Every call here assembles the FULL desired set of rules from persistence
 * — all still-active CYCLE grants across every obligation, plus every
 * checkout still awaiting approval, plus (optionally) one new/changed rule
 * the caller is in the middle of creating — and creates a brand-new policy
 * object representing that complete state. Never a delta, never an
 * in-place edit (Section A.6's hard rule against mutating a live policy).
 * A completed or expired checkout's rule is pruned lazily: it simply isn't
 * included the next time this runs, no separate live removal tap needed,
 * since Privy already stops honoring it past its own expiry regardless.
 *
 * **Deliberately does NOT touch persistence beyond the Privy API call.**
 * Creating a policy server-side needs no signature and may never actually
 * get attached — the owner-signed `addSigners()` tap happens client-side,
 * afterward, and can fail or be abandoned. If this function retargeted
 * every OTHER active grant's recorded `policy_id` to the new one right
 * here, a user backing out of that tap would leave every other obligation's
 * database row silently pointing at a policy that was never actually
 * attached to the wallet — the exact kind of premature-bookkeeping bug the
 * two-phase create-then-confirm pattern exists to prevent everywhere else
 * (see privy/policy.ts's header). Retargeting only happens once the caller
 * has independent confirmation the attach succeeded — see
 * http/routes/obligations.ts's `/grant` handler and http/routes/
 * checkout.ts's `/execute` handler for where that confirmation actually is.
 */

import type Database from "better-sqlite3";
import type { PrivyClient } from "@privy-io/node";
import { createCombinedPolicy, type GrantRuleParams } from "../privy/policy.js";
import { listActiveGrantsForUser } from "../persistence/grants.js";
import { listPendingCheckoutsForUser } from "../persistence/checkouts.js";
import { parseDecimalToBaseUnits } from "../domain/units.js";
import type { Hex } from "../domain/types.js";

export interface OperationsPolicyDeps {
  db: Database.Database;
  privy: PrivyClient;
  ausdAddress: Hex;
  ausdDecimals: number;
}

/** An additional rule to fold in on top of whatever's already active — the obligation/checkout the caller is in the middle of creating or renewing. */
export interface ExtraRule {
  label: string;
  recipientAddress: Hex;
  maxAmountBaseUnits: bigint;
  expiresAtUnix: number;
}

export interface RebuildResult {
  policyId: string;
  ruleCount: number;
}

/**
 * Rebuilds and reattaches-worthy (the caller still has to perform the real
 * owner-signed `useSigners().addSigners()` client-side) combined policy for
 * this user's shared agent signer. Also retargets every already-active
 * CYCLE grant's recorded `policy_id` to the new one, so bookkeeping matches
 * reality — see grants.ts's `retargetActiveGrantsPolicyId`.
 *
 * `excludingObligationId` is for renewal (Section A.4 step 6): when an
 * obligation's own grant is being renewed, its OLD (soon-to-expire) rule
 * must not also be pulled in from persistence alongside the fresh one the
 * caller passes as `extra` — that would attach two rules for the same
 * obligation, one already-stale.
 */
export async function rebuildOperationsPolicy(deps: OperationsPolicyDeps, userId: string, extra?: ExtraRule, excludingObligationId?: string): Promise<RebuildResult> {
  const activeCycleGrants = listActiveGrantsForUser(deps.db, userId, "CYCLE", excludingObligationId);
  const pendingCheckouts = listPendingCheckoutsForUser(deps.db, userId);

  const rules: GrantRuleParams[] = [
    ...activeCycleGrants.map(
      (g): GrantRuleParams => ({
        ausdAddress: deps.ausdAddress,
        recipientAddress: g.recipientAddress as Hex,
        maxAmountBaseUnits: parseDecimalToBaseUnits((g.maxAusdCost + g.maxFeeAusd).toFixed(6), deps.ausdDecimals),
        expiresAtUnix: Math.floor(new Date(g.expiresAt).getTime() / 1000),
        label: `Obligation ${g.obligationId}`,
      }),
    ),
    ...pendingCheckouts.map(
      (c): GrantRuleParams => ({
        ausdAddress: deps.ausdAddress,
        recipientAddress: c.merchantAddress,
        maxAmountBaseUnits: parseDecimalToBaseUnits(c.quote.ausdAmount, deps.ausdDecimals),
        expiresAtUnix: Math.floor(new Date(c.quote.expiresAt).getTime() / 1000),
        label: `Checkout ${c.id}`,
      }),
    ),
  ];

  if (extra) {
    rules.push({
      ausdAddress: deps.ausdAddress,
      recipientAddress: extra.recipientAddress,
      maxAmountBaseUnits: extra.maxAmountBaseUnits,
      expiresAtUnix: extra.expiresAtUnix,
      label: extra.label,
    });
  }

  const { policyId } = await createCombinedPolicy(deps.privy, rules, `Taxis ops — ${userId}`);

  return { policyId, ruleCount: rules.length };
}
