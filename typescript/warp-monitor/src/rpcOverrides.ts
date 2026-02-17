import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

/**
 * Applies RPC URL overrides from environment variables.
 * Checks all chains in metadata for RPC_URL_<CHAIN> env vars
 * (e.g., RPC_URL_ETHEREUM, RPC_URL_ARBITRUM_SEPOLIA) and overrides registry URLs.
 */
export function applyRpcOverrides(
  chainMetadata: Record<string, Partial<ChainMetadata>>,
): string[] {
  const overriddenChains: string[] = [];

  for (const chain of Object.keys(chainMetadata)) {
    const envVarName = `RPC_URL_${chain.toUpperCase().replace(/-/g, '_')}`;
    const rpcUrl = process.env[envVarName];
    if (rpcUrl) {
      rootLogger.debug(
        { chain, envVarName },
        'Using RPC from environment variable',
      );
      chainMetadata[chain].rpcUrls = [
        { http: rpcUrl },
      ] as ChainMetadata['rpcUrls'];
      overriddenChains.push(chain);
    }
  }

  return overriddenChains;
}
