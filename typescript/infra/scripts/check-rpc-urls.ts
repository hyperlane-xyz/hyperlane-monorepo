import { ethers } from 'ethers';

import { debug, error } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoint } from '../src/agents';

import { getArgs, getEnvironmentConfig } from './utils';

async function main() {
  const { environment } = await getArgs().argv;
  const config = await getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const chains = multiProvider.getKnownChainNames();
  const providers: [string, ethers.providers.JsonRpcProvider][] = [];
  for (const chain of chains) {
    debug(`Building providers for ${chain}`);
    const rpcUrl = await getSecretRpcEndpoint(environment, chain, false);
    providers.push([chain, new ethers.providers.StaticJsonRpcProvider(rpcUrl)]);
    const rpcData = await getSecretRpcEndpoint(environment, chain, true);
    (rpcData as string[]).forEach((url) => {
      providers.push([chain, new ethers.providers.StaticJsonRpcProvider(url)]);
    });
  }
  for (const [chain, provider] of providers) {
    debug(`Testing provider for ${chain}: ${provider.connection.url}`);
    try {
      await provider.getBlockNumber();
    } catch (e) {
      error(`Provider failed for ${chain}: ${provider.connection.url}`);
    }
  }
}

main()
  .then()
  .catch(() => process.exit(1));
