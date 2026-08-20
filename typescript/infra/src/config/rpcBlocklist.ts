import { ChainMap } from '@hyperlane-xyz/sdk';

// Full public RPC URLs to exclude from the validator's Quorum RPC pool, matched
// exactly against the URLs in the shared per-chain RPC secret. Only the
// validator's Quorum consensus fans every request out to all providers, so a
// chronically-erroring endpoint counts against reaching majority and trips the
// "Validator RPC Quorum Risk" alert. Relayer/scraper use Fallback consensus and
// never reach these endpoints, so this list is intentionally NOT applied to the
// general agent config or the shared RPC secret — only to the validator's
// CUSTOMRPCURLS at Helm render time (see hyperlane-agent/templates/
// external-secret.yaml, which drops these exact URLs from the secret list).
//
// Match is an exact full-URL equality: list only the public URLs, so private
// URLs that happen to share a host (but carry an API key) are never blocked.
export const blockedQuorumRpcUrls: ChainMap<string[]> = {
  // Chronic high-error public RPCs on arbitrum (see Linear AW-735). In the
  // validator Quorum pool these erred on the merkle-root eth_call ~97% (drpc)
  // and ~55% (arb1) of requests, counting against reaching majority.
  arbitrum: ['https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc'],
};
