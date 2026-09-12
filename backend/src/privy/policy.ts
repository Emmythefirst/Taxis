/**
 * Builds and creates the durable per-grant policy for a recurring
 * obligation (progress.md Section A.6, corrected model). One policy per
 * grant/renewal window — recipient + per-transaction cap + an expiry sized
 * to one cycle length plus a grace buffer, never the whole obligation's
 * duration, and never mutated in place once live (confirmed dangerous by
 * spike: an unowned policy's expiry can be extended by bare app
 * credentials with no owner signature at all).
 *
 * **What this module deliberately does NOT do**: attach the resulting
 * policy to a wallet's signer. That call (`wallets().update()` with
 * `additional_signers`) is owner-gated, and in production the owner is the
 * end user's own key — never something Taxis's backend holds. Attaching a
 * new grant (onboarding) or swapping in a renewed one is therefore a
 * CLIENT-SIDE action: the frontend calls Privy's
 * `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })`
 * while the user is authenticated, using the `policyId` this module
 * returns. This module only ever needs the app's own credentials — it
 * never touches an owner or agent private key.
 */

import type { PrivyClient } from "@privy-io/node";
import type { Hex } from "../domain/types.js";
import { ERC20_TRANSFER_ABI_JSON } from "./erc20.js";

export interface GrantPolicyParams {
  ausdAddress: Hex;
  recipientAddress: Hex;
  /** Per-transaction cap, in AUSD base units (see domain/units.ts). */
  maxAmountBaseUnits: bigint;
  /** Cycle length + grace buffer — never the whole obligation's duration. */
  expiresAtUnix: number;
  /** Kept under Privy's 50-character rule/policy name limit. */
  label: string;
}

export function buildGrantPolicyRequest(params: GrantPolicyParams) {
  return {
    version: "1.0",
    name: params.label.slice(0, 49),
    chain_type: "ethereum",
    rules: [
      {
        name: "Allow AUSD, recipient+cap+expiry".slice(0, 49),
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
      },
    ],
  };
}

export interface GrantPolicyResult {
  policyId: string;
  expiresAtUnix: number;
}

export async function createGrantPolicy(privy: PrivyClient, params: GrantPolicyParams): Promise<GrantPolicyResult> {
  const policy = await privy.policies().create(buildGrantPolicyRequest(params) as any);
  return { policyId: (policy as any).id as string, expiresAtUnix: params.expiresAtUnix };
}
