import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chains: ChainName[],
  minBalanceWei: string,
): Promise<boolean> {
  const address = await signer.getAddress();
  const minBalance = ethers.utils.formatEther(minBalanceWei.toString());
  let sufficient = true;
  await Promise.all(
    chains.map(async (chain) => {
      const balanceWei = await multiProvider
        .getProvider(chain)
        .getBalance(address);
      const balance = ethers.utils.formatEther(balanceWei);
      if (balanceWei.lt(minBalanceWei)) {
        const symbol =
          multiProvider.getChainMetadata(chain).nativeToken?.symbol ?? 'ETH';
        const error = `${address} has low balance on ${chain}. At least ${minBalance} recommended but found ${balance.toString()} ${symbol}`;
        const isResume = await confirm({
          message: `WARNING: ${error} Continue?`,
        });
        if (!isResume) throw new Error(error);
        sufficient = false;
      }
    }),
  );
  return sufficient;
}

export async function gasBalancesAreSufficient(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chains: ChainName[],
  minGas: string,
): Promise<boolean> {
  let sufficient = true;
  for (const chain of chains) {
    const provider = multiProvider.getProvider(chain);
    const gasPrice = await provider.getGasPrice();
    const minBalanceWei = gasPrice.mul(minGas).toString();
    sufficient = await nativeBalancesAreSufficient(
      multiProvider,
      signer,
      [chain],
      minBalanceWei,
    );
  }
  return sufficient;
}
