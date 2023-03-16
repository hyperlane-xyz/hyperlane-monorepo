import { JsonRpcSigner, StaticJsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { ChainName, MultiProvider, RetryProvider } from '@hyperlane-xyz/sdk';

export const resetFork = async (url: string) => {
  const provider = new StaticJsonRpcProvider();
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
): Promise<JsonRpcSigner> => {
  const provider = new StaticJsonRpcProvider('http://127.0.0.1:8545');
  await provider.send('hardhat_impersonateAccount', [account]);
  await provider.send('hardhat_setBalance', [
    account,
    ethers.utils.parseEther('42').toHexString(),
  ]);
  return provider.getSigner(account);
};

export const useLocalProvider = async (
  multiProvider: MultiProvider,
  chain: ChainName | number,
) => {
  const currentProvider = multiProvider.getProvider(chain);
  const network = await currentProvider.getNetwork();
  const provider = new StaticJsonRpcProvider(
    'http://127.0.0.1:8545',
    network.chainId,
  );
  const retryProvider = new RetryProvider(provider, {
    maxRequests: 5,
    baseRetryMs: 100,
  });
  multiProvider.setProvider(chain, retryProvider);
};
