import { ChainMap } from '@hyperlane-xyz/sdk';

// Hostnames of RPC providers to exclude from the validator's Quorum RPC pool,
// even when present in the shared per-chain RPC secret. Only the validator's
// Quorum consensus fans every request out to all providers, so a chronically
// erroring endpoint counts against reaching majority and trips the "Validator
// RPC Quorum Risk" alert. Relayer/scraper use Fallback consensus and never
// reach these endpoints, so this list is intentionally NOT applied to the
// general agent config or the shared RPC secret — only to the validator's
// CUSTOMRPCURLS at Helm render time (see hyperlane-agent/templates/
// external-secret.yaml, which filters the secret URL list by these hosts).
//
// Match is a substring test against the full URL performed in the Helm/
// external-secrets template. Use bare hostnames (no scheme/path); these are
// public endpoints with no API keys, so they cannot collide with private URLs.
export const blockedQuorumRpcUrlHosts: ChainMap<string[]> = {
  // Chronic high-error public RPCs on arbitrum (see Linear AW-735). In the
  // validator Quorum pool these erred on the merkle-root eth_call ~97% (drpc)
  // and ~55% (arb1) of requests, counting against reaching majority.
  arbitrum: ['arbitrum.drpc.org', 'arb1.arbitrum.io'],
};
