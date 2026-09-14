/**
 * Builds and creates Privy policies for the AUSD-transfer conditions this
 * project needs everywhere: recipient + per-transaction cap + expiry
 * (progress.md Section A.6, corrected model), never mutated in place once
 * live (confirmed dangerous by spike: an unowned policy's expiry can be
 * extended by bare app credentials with no owner signature at all — see
 * privy-policy-update-auth-spike.ts).
 *
 * **Two shapes, for two different reasons:**
 *
 * - `createGrantPolicy()` — a single-rule policy. Correct for a signer that
 *   only ever holds ONE grant at a time, which today means only the
 *   CONTINUITY quorum (Section A.8) — a dedicated signer per user, never
 *   shared with anything else.
 * - `createCombinedPolicy()` — one policy, one rule per active grant.
 *   Required for the shared AGENT quorum, which every recurring obligation
 *   AND every merchant checkout attaches to. **A spike
 *   (`privy-multi-policy-spike.ts`) proved a Privy signer can hold exactly
 *   ONE policy at a time** — `additional_signers[].override_policy_ids`
 *   rejects a second entry outright, it's not an AND/OR ambiguity to reason
 *   about. So two obligations (or an obligation + an in-flight checkout)
 *   sharing the agent signer cannot each have their own policy; they must
 *   all be rules inside the SAME policy. See `engine/operationsPolicy.ts`
 *   for the orchestration that rebuilds this policy from the full current
 *   set of active grants every time any one of them changes.
 *
 * **What this module deliberately does NOT do, either way**: attach the
 * resulting policy to a wallet's signer. That call (`wallets().update()`
 * with `additional_signers`) is owner-gated, and in production the owner is
 * the end user's own key — never something Taxis's backend holds. Attaching
 * a new grant or swapping in a rebuilt one is therefore a CLIENT-SIDE
 * action: the frontend calls Privy's `useSigners().addSigners({ address,
 * signers: [{ signerId, policyIds }] })` while the user is authenticated,
 * using the `policyId` this module returns. This module only ever needs the
 * app's own credentials — it never touches an owner or agent private key.
 */

import type { PrivyClient } from "@privy-io/node";
import type { Hex } from "../domain/types.js";
import { ERC20_TRANSFER_ABI_JSON } from "./erc20.js";

export interface GrantRuleParams {
  ausdAddress: Hex;
  recipientAddress: Hex;
  /** Per-transaction cap, in AUSD base units (see domain/units.ts). */
  maxAmountBaseUnits: bigint;
  /** Cycle length + grace buffer — never the whole obligation's duration. */
  expiresAtUnix: number;
  /** Kept under Privy's 50-character rule/policy name limit. */
  label: string;
}

/** Backward-compatible alias — a single grant's params are exactly one rule's params. */
export type GrantPolicyParams = GrantRuleParams;

export function buildGrantRule(params: GrantRuleParams) {
  return {
    name: params.label.slice(0, 49),
    method: "eth_sendTransaction",
    action: "ALLOW",
    conditions: [
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: params.ausdAddress },
      {
        field_source: "ethereum_calldata",
        field: "transfer.recipient",
        abi: ERC20_TRANSFER_ABI_JSON,
        operator: "eq",
        value: params.recipientAddress,
      },
      {
        field_source: "ethereum_calldata",
        field: "transfer.amount",
        abi: ERC20_TRANSFER_ABI_JSON,
        operator: "lte",
        value: `0x${params.maxAmountBaseUnits.toString(16)}`,
      },
      {
        field_source: "system",
        field: "current_unix_timestamp",
        operator: "lt",
        value: String(params.expiresAtUnix),
      },
    ],
  };
}

export function buildGrantPolicyRequest(params: GrantRuleParams) {
  return {
    version: "1.0",
    name: params.label.slice(0, 49),
    chain_type: "ethereum",
    rules: [buildGrantRule(params)],
  };
}

export interface GrantPolicyResult {
  policyId: string;
  expiresAtUnix: number;
}

/** Single-rule policy — correct only for a signer that holds exactly one grant (today: the CONTINUITY quorum). */
export async function createGrantPolicy(privy: PrivyClient, params: GrantRuleParams): Promise<GrantPolicyResult> {
  const policy = await privy.policies().create(buildGrantPolicyRequest(params) as any);
  return { policyId: (policy as any).id as string, expiresAtUnix: params.expiresAtUnix };
}

export function buildCombinedPolicyRequest(rules: GrantRuleParams[], label: string) {
  return {
    version: "1.0",
    name: label.slice(0, 49),
    chain_type: "ethereum",
    rules: rules.map(buildGrantRule),
  };
}

export interface CombinedPolicyResult {
  policyId: string;
}

/**
 * One policy, one rule per currently-active grant on the shared AGENT
 * signer. Callers must pass the FULL current set of rules that should
 * still be authorized — this creates a brand-new policy object (never
 * mutates one in place) representing the complete desired state, not a
 * delta. See `engine/operationsPolicy.ts` for how that full set gets
 * assembled from persistence.
 */
export async function createCombinedPolicy(privy: PrivyClient, rules: GrantRuleParams[], label = "Taxis operations policy"): Promise<CombinedPolicyResult> {
  const policy = await privy.policies().create(buildCombinedPolicyRequest(rules, label) as any);
  return { policyId: (policy as any).id as string };
}
