import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chains: ChainName[],
  minGas: string,
): Promise<boolean[]> {
  const address = await signer.getAddress();

  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
    const provider = multiProvider.getProvider(chain);
    const gasPrice = await provider.getGasPrice();
    const minBalanceWei = gasPrice.mul(minGas).toString();

    const balanceWei = await multiProvider
      .getProvider(chain)
      .getBalance(address);
    const balance = ethers.utils.formatEther(balanceWei);
    if (balanceWei.lt(minBalanceWei)) {
      const symbol =
        multiProvider.getChainMetadata(chain).nativeToken?.symbol ?? 'ETH';
      const error = `${address} has low balance on ${chain}. At least ${minBalanceWei} recommended but found ${balance.toString()} ${symbol}`;
      const isResume = await confirm({
        message: `WARNING: ${error} Continue?`,
      });
      if (!isResume) throw new Error(error);
      sufficientBalances.push(false);
    }
  }

  return sufficientBalances;
}
