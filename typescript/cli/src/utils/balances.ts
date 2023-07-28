import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

export async function assertBalances(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chains: ChainName[],
  minBalance = 0,
) {
  const address = await signer.getAddress();
  const minBalanceWei = ethers.utils.parseEther(minBalance.toString());
  await Promise.all(
    chains.map(async (chain) => {
      const balanceWei = await multiProvider
        .getProvider(chain)
        .getBalance(address);
      const balance = ethers.utils.formatEther(balanceWei);
      if (balanceWei.lte(minBalanceWei))
        throw new Error(
          `${address} has insufficient balance on ${chain}. At least ${minBalance} required but found ${balance.toString()} ETH`,
        );
    }),
  );
}
