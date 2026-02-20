import { ChainName, MultiProvider, getLocalProvider } from '@hyperlane-xyz/sdk';

type LocalProvider = ReturnType<typeof getLocalProvider>;
type LocalSigner = ReturnType<LocalProvider['getSigner']>;

export const resetFork = async (url: string) => {
  const provider = getLocalProvider();
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
): Promise<LocalSigner> => {
  const provider = getLocalProvider();
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
  const provider = getLocalProvider();
  multiProvider.setProvider(chain, provider);
};
