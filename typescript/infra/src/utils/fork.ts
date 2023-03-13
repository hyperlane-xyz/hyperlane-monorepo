import { JsonRpcProvider } from '@ethersproject/providers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

const resetFork = async (provider: JsonRpcProvider, forkUrl: string) => {
  await provider.send('hardhat_reset', [
    {
      forking: {
        jsonRpcUrl: forkUrl,
      },
    },
  ]);
};

const ownerSigner = async (provider: JsonRpcProvider, config: CoreConfig) => {
  await provider.send('hardhat_impersonateAccount', [config.owner]);
  const signer = provider.getSigner(config.owner);
  return signer;
};

export const forkAndImpersonateOwner = async (
  chain: ChainName,
  config: ChainMap<CoreConfig>,
  multiProvider: MultiProvider,
) => {
  const forkUrl = multiProvider.getRpcUrl(chain);
  const provider = new JsonRpcProvider('http://localhost:8545');

  await resetFork(provider, forkUrl);

  const signer = await ownerSigner(provider, config[chain]);
  multiProvider.setProvider(chain, provider);
  multiProvider.setSigner(chain, signer);
  return multiProvider;
};
