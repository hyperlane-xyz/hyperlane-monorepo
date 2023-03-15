import {
  JsonRpcProvider,
  JsonRpcSigner,
  Network,
} from '@ethersproject/providers';

import { MultiProvider, providerBuilder } from '@hyperlane-xyz/sdk';

import { defaultRetry } from '../config/chain';

export const fork = async (provider: JsonRpcProvider, url: string) => {
  await provider.send('hardhat_reset', [
    {
      forking: {
        jsonRpcUrl: url,
      },
    },
  ]);
};

export const impersonateAccount = async (
  provider: JsonRpcProvider,
  account: string,
): Promise<JsonRpcSigner> => {
  await provider.send('hardhat_impersonateAccount', [account]);
  return provider.getSigner(account);
};

export const useLocalProvider = async (
  multiProvider: MultiProvider,
): Promise<{ provider: JsonRpcProvider; network: Network }> => {
  const provider = providerBuilder({ retry: defaultRetry });
  const network = await provider.getNetwork();
  multiProvider.setProvider(network.chainId, provider);
  return { provider, network };
};
