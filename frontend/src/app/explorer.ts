/**
 * MonadVision — confirmed as Monad's real explorer brand via its own docs
 * (docs.monad.xyz references "MonadVision" for mainnet), and this testnet
 * subdomain is where the OLD testnet.monadexplorer.com domain now
 * permanently redirects. The exact /tx/ path itself is inferred (the site
 * blocks automated fetching, so it couldn't be click-verified from here) —
 * it's the near-universal EVM block-explorer convention (Etherscan,
 * Blockscout, etc.), not a guess made from nothing, but worth one real
 * click to confirm before relying on it in front of judges.
 */
export function explorerTxUrl(hash: string): string {
  return `https://testnet.monadvision.com/tx/${hash}`;
}
