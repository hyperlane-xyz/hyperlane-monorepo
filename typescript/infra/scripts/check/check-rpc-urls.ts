import { type PublicClient, createPublicClient, http } from 'viem';

import { rootLogger } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoints } from '../../src/agents/index.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const chains = multiProvider.getKnownChainNames();
  const providers: [string, string, PublicClient][] = [];
  for (const chain of chains) {
    rootLogger.debug(`Building providers for ${chain}`);
    const rpcData = await getSecretRpcEndpoints(environment, chain);
    for (const url of rpcData)
      providers.push([
        chain,
        url,
        createPublicClient({ transport: http(url) }),
      ]);
  }
  for (const [chain, url, provider] of providers) {
    rootLogger.debug(`Testing provider for ${chain}: ${url}`);
    try {
      await provider.getBlockNumber();
    } catch (error) {
      rootLogger.error(
        `Provider failed for ${chain}: ${url} (${String(error)})`,
      );
    }
  }
}

main()
  .then()
  .catch(() => process.exit(1));
