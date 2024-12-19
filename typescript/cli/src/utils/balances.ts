import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { autoConfirm } from '../config/prompts.js';
import { logBlue, logGray, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  chains: ChainName[],
  minGas: string,
  skipConfirmation: boolean,
) {
  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
    // Only Ethereum chains are supported
    if (multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
      logGray(`Skipping balance check for non-EVM chain: ${chain}`);
      continue;
    }
    const address = await multiProvider.getSigner(chain).getAddress();
    const provider = multiProvider.getProvider(chain);
    const gasPrice = await provider.getGasPrice();
    const minBalanceWei = gasPrice.mul(minGas).toString();
    const minBalance = ethers.utils.formatEther(minBalanceWei.toString());

    const balanceWei = await multiProvider
      .getProvider(chain)
      .getBalance(address);
    const balance = ethers.utils.formatEther(balanceWei.toString());
    if (balanceWei.lt(minBalanceWei)) {
      const symbol =
        multiProvider.getChainMetadata(chain).nativeToken?.symbol ?? 'ETH';
      logRed(
        `WARNING: ${address} has low balance on ${chain}. At least ${minBalance} ${symbol} recommended but found ${balance} ${symbol}`,
      );
      sufficientBalances.push(false);
    }
  }
  const allSufficient = sufficientBalances.every((sufficient) => sufficient);

  if (allSufficient) {
    logGreen('✅ Balances are sufficient');
  } else {
    warnYellow(`Deployment may fail due to insufficient balance(s)`);
    const isResume = await autoConfirm('Continue?', skipConfirmation, () =>
      logBlue('Continuing deployment with insufficient balances'),
    );
    if (!isResume) throw new Error('Canceled deployment due to low balance');
  }
}
