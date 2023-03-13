import { JsonRpcProvider } from '@ethersproject/providers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const resetFork = async (
  chain: ChainName,
  multiProvider: MultiProvider,
) => {
  const provider = multiProvider.getProvider(chain) as JsonRpcProvider;
  await provider.send('hardhat_reset', [
    {
      forking: {
        jsonRpcUrl: multiProvider.getRpcUrl(chain),
      },
    },
  ]);
};

export const impersonateOwner = async (
  chain: ChainName,
  config: ChainMap<CoreConfig>,
  multiProvider: MultiProvider,
) => {
  const provider = multiProvider.getProvider(chain) as JsonRpcProvider;
  const chainConfig = config[chain];
  await provider.send('hardhat_impersonateAccount', [chainConfig.owner]);
  const signer = provider.getSigner(chainConfig.owner);
  multiProvider.setSigner(chain, signer);
};

export const fork = async (
  chain: ChainName,
  multiProvider: MultiProvider,
  reset = true,
) => {
  const provider = new JsonRpcProvider('http://localhost:8545');
  multiProvider.setProvider(chain, provider);
  if (reset) {
    await resetFork(chain, multiProvider);
  }
};
