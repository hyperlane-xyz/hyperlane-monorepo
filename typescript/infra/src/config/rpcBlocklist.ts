import { ChainMap, ChainName, parseCustomRpcHeaders } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

// Hostnames of RPC providers to exclude from agent RPC pools (both Quorum and
// Fallback consensus), even when present in registry metadata or the per-chain
// RPC secret. Use this for chronically unreliable public endpoints — e.g. ones
// that repeatedly trip the "Validator RPC Quorum Risk" alert by erroring on the
// majority of requests. Match is by hostname so URLs with paths, API keys, or
// custom header syntax are handled uniformly.
export const blockedRpcUrlHosts: ChainMap<string[]> = {
  // Chronic high-error public RPCs on arbitrum (see Linear AW-735). These sit
  // in the validator Quorum pool and count against reaching majority.
  arbitrum: ['arbitrum.drpc.org', 'arb1.arbitrum.io'],
};

function hostOf(url: string): string | undefined {
  // RPC URLs may carry custom headers appended after the URL; strip them first.
  const { url: cleanUrl } = parseCustomRpcHeaders(url);
  try {
    return new URL(cleanUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isRpcUrlBlocked(chain: ChainName, url: string): boolean {
  const blocked = blockedRpcUrlHosts[chain];
  if (!blocked?.length) return false;
  const host = hostOf(url);
  if (!host) return false;
  return blocked.some((blockedHost) => host === blockedHost.toLowerCase());
}

// Returns `urls` with any blocked hosts removed. Logs each dropped URL so the
// removal is visible in config-generation and RPC-set flows.
export function filterBlockedRpcUrls(
  chain: ChainName,
  urls: string[],
): string[] {
  return urls.filter((url) => {
    if (isRpcUrlBlocked(chain, url)) {
      rootLogger.warn(`Dropping blocked RPC URL for ${chain}: ${hostOf(url)}`);
      return false;
    }
    return true;
  });
}
