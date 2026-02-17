import { rootLogger } from './logging.js';

export interface ChainMetadataWithRpcUrls {
  rpcUrls?: { http: string }[];
}

interface ApplyRpcUrlOverridesOptions {
  chainNames?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Applies RPC URL overrides from environment variables.
 * Looks for variables with the form RPC_URL_<CHAIN_NAME>.
 */
export function applyRpcUrlOverridesFromEnv(
  chainMetadata: Record<string, ChainMetadataWithRpcUrls | undefined>,
  options: ApplyRpcUrlOverridesOptions = {},
): string[] {
  const overriddenChains: string[] = [];
  const chainNames = options.chainNames ?? Object.keys(chainMetadata);
  const env = options.env ?? process.env;

  for (const chain of chainNames) {
    const metadata = chainMetadata[chain];
    if (!metadata) continue;

    const envVarName = `RPC_URL_${chain.toUpperCase().replace(/-/g, '_')}`;
    const rpcUrl = env[envVarName];
    if (!rpcUrl) continue;

    rootLogger.debug(
      { chain, envVarName },
      'Using RPC from environment variable',
    );
    metadata.rpcUrls = [{ http: rpcUrl }];
    overriddenChains.push(chain);
  }

  return overriddenChains;
}
