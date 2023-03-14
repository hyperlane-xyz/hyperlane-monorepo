import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

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

export const useLocalProvider = (
  multiProvider: MultiProvider,
  chain: ChainName,
  port = 8545,
): JsonRpcProvider => {
  const provider = new JsonRpcProvider(`http://localhost:${port}`);
  multiProvider.setProvider(chain, provider);
  return provider;
};
