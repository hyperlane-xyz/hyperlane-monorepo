import { ethers } from 'ethers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoints } from '../../src/agents/index.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const chains = multiProvider.getKnownChainNames();
  const providers: [string, ethers.providers.JsonRpcProvider][] = [];
  for (const chain of chains) {
    rootLogger.debug(`Building providers for ${chain}`);
    const rpcData = await getSecretRpcEndpoints(environment, chain);
    for (const url of rpcData)
      providers.push([chain, new ethers.providers.StaticJsonRpcProvider(url)]);
  }
  for (const [chain, provider] of providers) {
    rootLogger.debug(
      `Testing provider for ${chain}: ${provider.connection.url}`,
    );
    try {
      await provider.getBlockNumber();
    } catch (e) {
      rootLogger.error(
        `Provider failed for ${chain}: ${provider.connection.url}`,
      );
    }
  }
}

main()
  .then()
  .catch(() => process.exit(1));
