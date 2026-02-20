import { providers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

export const resetFork = async (url: string) => {
  const provider = new providers.JsonRpcProvider();
  await provider.send('hardhat_reset', [
    {
      forking: {
        jsonRpcUrl: url,
      },
    },
  ]);
};

export const impersonateAccount = async (
  account: string,
  spoofBalance?: number,
): Promise<providers.JsonRpcSigner> => {
  const provider = new providers.JsonRpcProvider('http://127.0.0.1:8545');
  await provider.send('hardhat_impersonateAccount', [account]);
  if (spoofBalance) {
    await provider.send('hardhat_setBalance', [account, spoofBalance]);
  }
  return provider.getSigner(account);
};

export const useLocalProvider = async (
  multiProvider: MultiProvider,
  chain: ChainName | number,
) => {
  const provider = new providers.JsonRpcProvider('http://127.0.0.1:8545');
  multiProvider.setProvider(chain, provider);
};
