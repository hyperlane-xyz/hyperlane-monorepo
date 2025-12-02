import { ChainName } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Extracts the base domain from a URL (e.g., alchemy.com instead of eth-mainnet.g.alchemy.com)
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Split hostname into parts
    const parts = hostname.split('.');

    // Handle IP addresses
    if (parts.every((part) => /^\d+$/.test(part))) {
      return hostname;
    }

    // For most domains, take the last 2 parts (domain.tld)
    // This handles: subdomain.alchemy.com -> alchemy.com
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }

    return hostname;
  } catch (e) {
    const match = url.match(/^(?:https?:\/\/)?([^\/\?#]+)/);
    if (!match) return url;

    const hostname = match[1];
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }
    return hostname;
  }
}

async function main() {
  const { environment } = await getArgs().argv;

  const domainMap: Record<
    string,
    {
      domain: string;
      chains: ChainName[];
    }
  > = {};

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry(true);
  const supportedChains = envConfig.supportedChainNames;

  for (const chain of supportedChains) {
    try {
      const metadata = await registry.getChainMetadata(chain);
      assert(metadata, `Chain metadata not found for chain ${chain}`);
      assert(metadata.rpcUrls, `Chain RPC URLs not found for chain ${chain}`);
      const rpcUrls = metadata.rpcUrls.map((rpc: { http: string }) => rpc.http);

      for (const url of rpcUrls) {
        const domain = extractDomain(url);

        if (!domainMap[domain]) {
          domainMap[domain] = {
            domain,
            chains: [],
          };
        }

        domainMap[domain].chains.push(chain);
      }
    } catch (e) {
      console.error(`Error getting chain metadata for chain ${chain}: ${e}`);
      // Skip chains that error
    }
  }

  const sortedDomains = Object.values(domainMap).sort(
    (a, b) => b.chains.length - a.chains.length,
  );

  for (const domainInfo of sortedDomains) {
    console.log(`\n${domainInfo.domain} (${domainInfo.chains.length})`);
    console.log(`    ${domainInfo.chains.join(', ')}`);
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
