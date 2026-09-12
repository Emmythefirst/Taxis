/**
 * Policy-update authorization spike — follow-up to privy-recurring-policy-spike.ts.
 *
 * The recurring-policy spike proved that RENEWAL VIA "create a new policy,
 * then owner-signed wallets().update() to reattach it" works and is
 * owner-gated. It did NOT test a different, cheaper-looking path: mutating
 * an EXISTING policy's own expiry condition in place via
 * privy.policies().updateRule(), instead of creating a new policy object
 * each renewal.
 *
 * This matters a lot: `Policy` has its own `owner_id`, separate from the
 * wallet's owner_id (confirmed by reading the SDK's resource types). Our
 * policies were created via `privy.policies().create({...})` without ever
 * setting `owner_id` — so if Privy's usual "unset owner -> app has default
 * control" pattern (already seen twice: wallets, and implicitly here) also
 * applies to policies, then Taxis's own backend credentials alone might be
 * able to push a policy's expiry forward indefinitely, with NO owner (user)
 * signature required at all. If that's true, "renew by mutating the
 * existing policy" would silently bypass the entire owner-gating guarantee
 * the periodic-re-consent design depends on — a compromised backend could
 * just keep extending its own leash forever.
 *
 * This script checks, empirically, who can actually authorize
 * updateRule() on a policy already attached to a live signer:
 *   1. No authorization_context at all (bare app credentials).
 *   2. The AGENT quorum's own key (would be almost as bad as #1 if it works
 *      — the agent could self-renew without the user ever being involved).
 *   3. The OWNER quorum's key (the only outcome that would make this path
 *      as safe as the already-proven create-new-policy-and-reattach path).
 *
 * Whichever succeeds determines whether "update policy in place" is ever
 * safe to use for renewal in the quote engine, or whether renewal must
 * always go through creating a fresh policy + an owner-signed wallet update
 * (the mechanism already confirmed safe).
 */

import "dotenv/config";
import { PrivyClient } from "@privy-io/node";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const AUSD_ADDRESS = requireEnv("AUSD_TESTNET_ADDRESS") as `0x${string}`;

async function main() {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const agentQuorumId = requireEnv("PRIVY_AGENT_KEY_QUORUM_ID");
  const ownerQuorumId = requireEnv("PRIVY_OWNER_KEY_QUORUM_ID");
  const agentPrivateKey = requireEnv("PRIVY_AGENT_PRIVATE_KEY_B64");
  const ownerPrivateKey = requireEnv("PRIVY_OWNER_PRIVATE_KEY_B64");
  const validRecipient = requireEnv("KILL_TEST_VALID_RECIPIENT") as `0x${string}`;
  const walletId = requireEnv("KILL_TEST_WALLET_ID");

  const agentContext = { authorization_private_keys: [agentPrivateKey] };
  const ownerContext = { authorization_private_keys: [ownerPrivateKey] };

  const privy = new PrivyClient({ appId, appSecret });

  // Ensure owner is set (idempotent; needs owner auth if already set).
  try {
    await privy.wallets().update(walletId, { owner_id: ownerQuorumId } as any);
  } catch {
    await privy.wallets().update(walletId, { authorization_context: ownerContext, owner_id: ownerQuorumId } as any);
  }

  console.log("Creating a policy and attaching it as the agent's live signer...");
  const initialExpiry = Math.floor(Date.now() / 1000) + 60;
  const policy = await privy.policies().create({
    version: "1.0",
    name: "Policy-update auth spike",
    chain_type: "ethereum",
    rules: [
      {
        name: "Allow to AUSD contract before expiry",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: AUSD_ADDRESS },
          { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: String(initialExpiry) },
        ],
      },
    ],
  } as any);
  const policyId = (policy as any).id as string;
  const ruleId = (policy as any).rules[0].id as string;
  console.log(`  policy id=${policyId} rule id=${ruleId} owner_id=${(policy as any).owner_id ?? "null (unset)"}`);
  console.log(`  initial expiry: ${new Date(initialExpiry * 1000).toISOString()}`);

  await privy.wallets().update(walletId, {
    authorization_context: ownerContext,
    additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [policyId] }],
  } as any);
  console.log("  attached to agent quorum as a live signer.\n");

  const newExpiry = Math.floor(Date.now() / 1000) + 3600;
  const attempt = async (label: string, authorization_context?: any) => {
    try {
      await privy.policies().updateRule(ruleId, {
        policy_id: policyId,
        ...(authorization_context ? { authorization_context } : {}),
        name: "Allow to AUSD contract before expiry",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: AUSD_ADDRESS },
          { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: String(newExpiry) },
        ],
      } as any);
      console.log(`✅ SUCCEEDED: ${label} was able to extend the policy's expiry`);
      return true;
    } catch (err) {
      console.log(`❌ FAILED: ${label} — ${String(err).split("\n")[0]}`);
      return false;
    }
  };

  console.log("[1] Attempting updateRule() with NO authorization_context (bare app credentials)...");
  const bareWorked = await attempt("bare app credentials");

  console.log("\n[2] Attempting updateRule() authorized with the AGENT's own key...");
  const agentWorked = bareWorked ? null : await attempt("agent quorum key", agentContext);

  console.log("\n[3] Attempting updateRule() authorized with the OWNER's key...");
  const ownerWorked = bareWorked || agentWorked ? null : await attempt("owner quorum key", ownerContext);

  console.log("\n--- Verdict ---");
  if (bareWorked) {
    console.log(
      "DANGEROUS: policies created without an explicit owner_id can be mutated by bare app credentials.\n" +
        "  -> 'Renew by updating an existing policy in place' MUST NOT be used for recurring obligations.\n" +
        "  -> Always create a fresh policy + reattach via an owner-signed wallets().update() (already proven safe).",
    );
  } else if (agentWorked) {
    console.log(
      "DANGEROUS: the agent's own signer key can extend its own policy's expiry unilaterally.\n" +
        "  -> Same conclusion as above: never use in-place policy updates for renewal.",
    );
  } else if (ownerWorked) {
    console.log(
      "SAFE: only the owner's (user's) key can extend an already-attached policy's expiry.\n" +
        "  -> In-place policy update IS a valid renewal mechanism, gated the same way as the\n" +
        "     already-proven create-new-policy path. Either approach is safe to use.",
    );
  } else {
    console.log(
      "INCONCLUSIVE / policy resource is gated by something else entirely (e.g. requires the policy's\n" +
        "  OWN owner_id to be explicitly set to one of our quorums first, or another mechanism not\n" +
        "  covered by the three attempts above). Do not assume either renewal path is safe — investigate\n" +
        "  the actual error messages above before building the quote engine's renewal logic on this.",
    );
  }
}

main().catch((err) => {
  console.error("Policy-update auth spike crashed:", err);
  process.exit(1);
});
