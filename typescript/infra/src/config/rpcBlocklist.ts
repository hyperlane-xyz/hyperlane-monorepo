import { ChainMap } from '@hyperlane-xyz/sdk';

// Full public RPC URLs to exclude from the validator's additional quorum RPC
// pool (CUSTOMADDITIONALQUORUMRPCURLS), matched exactly against the public
// registry rpcUrls. Only the validator fans every request out to all providers
// in this pool, so a chronically-erroring endpoint counts against reaching
// majority and trips the "Validator RPC Quorum Risk" alert. Relayer/scraper use
// Fallback consensus and never reach these endpoints, so this list is
// intentionally NOT applied to the general agent config or the shared RPC secret
// — only to the validator's publicRpcUrls at Helm-values build time (see
// ValidatorHelmManager in src/agents/index.ts).
//
// Match is an exact full-URL equality: list only the public URLs, so private
// URLs that happen to share a host (but carry an API key) are never blocked.
export const blockedQuorumRpcUrls: ChainMap<string[]> = {
  // Chronic high-error public RPCs on arbitrum (see Linear AW-735). In the
  // validator Quorum pool these erred on the merkle-root eth_call ~97% (drpc)
  // and ~55% (arb1) of requests, counting against reaching majority.
  arbitrum: ['https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc'],
};
