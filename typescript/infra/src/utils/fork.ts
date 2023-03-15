import {
  JsonRpcProvider,
  JsonRpcSigner,
  Network,
} from '@ethersproject/providers';
import { ethers } from 'ethers';

import { MultiProvider } from '@hyperlane-xyz/sdk';

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
  await provider.send('hardhat_setBalance', [
    account,
    ethers.utils.parseEther('42').toHexString(),
  ]);
  return provider.getSigner(account);
};

export const useLocalProvider = async (
  multiProvider: MultiProvider,
): Promise<{ provider: JsonRpcProvider; network: Network }> => {
  const provider = new JsonRpcProvider();
  const network = await provider.getNetwork();
  if (network.name === 'homestead') {
    network.name = 'ethereum';
  }
  multiProvider.setProvider(network.chainId, provider);
  return { provider, network };
};
