import type { ContinuityStatus } from "../api/endpoints";
import type { GrantWithObligation } from "./AppDataContext";

export interface SignerEntry {
  signerId: string;
  policyIds: string[];
}

/**
 * Confirmed live, not assumed: Privy's `addSigners()` is additive-only —
 * it REJECTS re-adding a `signerId` that's already attached to the wallet
 * ("Duplicate signer(s) provided when updating wallet"), and their own
 * docs confirm it ("Adds signers to a wallet"). `removeSigners()` strips
 * EVERY signer at once — there is no "update one signer's policy"
 * operation. This broke the first version of Renew/Cancel: calling
 * addSigners() again with the agent quorum's NEW policy, after it was
 * already attached once, failed outright.
 *
 * The only safe way to change either signer's policy is:
 *   1. removeSigners({ address })      — strip everything
 *   2. addSigners({ address, signers: [...] }) — re-add the COMPLETE
 *      desired set in one call
 *
 * Never just the one signer that changed — if the agent quorum is being
 * updated (New Payment, Renew, Cancel) and continuity is separately
 * configured, omitting continuity's entry would silently strip its
 * authority too, and vice versa when continuity itself is being set up or
 * changed (ContinuitySetup.tsx) — the agent's current policy must be
 * preserved alongside it.
 *
 * Always removes first, unconditionally — deliberately NOT conditioned on
 * "does an active grant already exist," which was tried and found wrong:
 * cancelling a user's LAST active obligation revokes its grant ROW but
 * does NOT detach the agent signer from the wallet (only the wallet-level
 * kill switch's removeSigners() does that) — so grant status alone can't
 * reliably answer "is this signerId currently attached?" in every case
 * (first-ever attach vs. attach-after-cancelling-everything vs.
 * attach-after-a-kill-switch all look different from the backend's
 * bookkeeping, but removeSigners() handles all three identically and
 * correctly). A `removeSigners()` call on an already-empty signer list is
 * expected to be a harmless no-op (standard "clear all" semantics), so the
 * extra call costs a little, not correctness.
 */
export async function reattachSigners(params: {
  addSigners: (args: { address: string; signers: SignerEntry[] }) => Promise<unknown>;
  removeSigners: (args: { address: string }) => Promise<unknown>;
  walletAddress: string;
  /** The desired final agent signer state — omit if the agent signer
   *  isn't part of this particular update (e.g. a pure continuity change
   *  on a wallet with no obligations at all). */
  agent?: { agentQuorumId: string; policyId: string };
  /** The desired final continuity signer state — omit if continuity isn't
   *  part of this particular update. */
  continuity?: { continuityQuorumId: string; policyId: string };
}): Promise<void> {
  await params.removeSigners({ address: params.walletAddress });
  const signers: SignerEntry[] = [];
  if (params.agent) signers.push({ signerId: params.agent.agentQuorumId, policyIds: [params.agent.policyId] });
  if (params.continuity) signers.push({ signerId: params.continuity.continuityQuorumId, policyIds: [params.continuity.policyId] });
  await params.addSigners({ address: params.walletAddress, signers });
}

/** The agent's currently-attached {agentQuorumId, policyId}, derived from
 *  any still-ACTIVE CYCLE grant — every such grant carries both fields,
 *  and by construction they're all the same combined policy. Undefined if
 *  no obligation currently has an active grant (nothing to preserve). */
export function currentAgentSigner(grants: GrantWithObligation[]): { agentQuorumId: string; policyId: string } | undefined {
  const active = grants.find((g) => g.grant.kind === "CYCLE" && g.grant.status === "ACTIVE");
  return active ? { agentQuorumId: active.grant.agentQuorumId, policyId: active.grant.policyId } : undefined;
}

/**
 * Convenience wrapper for the common case — updating the AGENT signer's
 * policy (obligation creation, Renew, Cancel) while preserving continuity
 * untouched if it's separately configured.
 */
export function reattachAgentSigner(params: {
  addSigners: (args: { address: string; signers: SignerEntry[] }) => Promise<unknown>;
  removeSigners: (args: { address: string }) => Promise<unknown>;
  walletAddress: string;
  continuity: ContinuityStatus | undefined;
  agent: { agentQuorumId: string; policyId: string };
}): Promise<void> {
  const continuity =
    params.continuity?.configured && params.continuity.continuityQuorumId && params.continuity.policyId
      ? { continuityQuorumId: params.continuity.continuityQuorumId, policyId: params.continuity.policyId }
      : undefined;
  return reattachSigners({
    addSigners: params.addSigners,
    removeSigners: params.removeSigners,
    walletAddress: params.walletAddress,
    agent: params.agent,
    continuity,
  });
}

/**
 * Convenience wrapper for the inverse case — setting up or changing the
 * CONTINUITY signer's policy (ContinuitySetup.tsx), while preserving the
 * agent's current policy if any obligation already has one attached.
 */
export function reattachContinuitySigner(params: {
  addSigners: (args: { address: string; signers: SignerEntry[] }) => Promise<unknown>;
  removeSigners: (args: { address: string }) => Promise<unknown>;
  walletAddress: string;
  grants: GrantWithObligation[];
  continuity: { continuityQuorumId: string; policyId: string };
}): Promise<void> {
  return reattachSigners({
    addSigners: params.addSigners,
    removeSigners: params.removeSigners,
    walletAddress: params.walletAddress,
    agent: currentAgentSigner(params.grants),
    continuity: params.continuity,
  });
}
