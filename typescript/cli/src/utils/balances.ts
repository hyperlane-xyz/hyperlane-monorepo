import { GasPrice } from '@cosmjs/stargate';
import { BigNumber } from 'bignumber.js';
import { ethers } from 'ethers';

import {
  ChainName,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { autoConfirm } from '../config/prompts.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { logBlue, logGray, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  multiProtocolProvider: MultiProtocolProvider,
  multiProtocolSigner: MultiProtocolSignerManager,
  chains: ChainName[],
  minGas: typeof MINIMUM_WARP_DEPLOY_GAS,
  skipConfirmation: boolean,
) {
  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
    const protocolType = multiProvider.getProtocol(chain);

    switch (protocolType) {
      case ProtocolType.Ethereum: {
        const address = await multiProtocolSigner
          .getEVMSigner(chain)
          .getAddress();
        const provider = multiProtocolProvider.getEthersV5Provider(chain);
        const gasPrice = await provider.getGasPrice();
        const minBalanceWei = gasPrice
          .mul(minGas[ProtocolType.Ethereum])
          .toString();
        const minBalance = ethers.utils.formatEther(minBalanceWei.toString());

        const balanceWei = await provider.getBalance(address);
        const balance = ethers.utils.formatEther(balanceWei.toString());
        if (balanceWei.lt(minBalanceWei)) {
          const symbol =
            multiProvider.getChainMetadata(chain).nativeToken?.symbol ?? 'ETH';
          logRed(
            `WARNING: ${address} has low balance on ${chain}. At least ${minBalance} ${symbol} recommended but found ${balance} ${symbol}`,
          );
          sufficientBalances.push(false);
        }
        break;
      }
      case ProtocolType.Cosmos: {
        const address =
          multiProtocolSigner.getCosmosNativeSigner(chain).account.address;
        const provider = await multiProtocolProvider.getCosmJsProvider(chain);
        const { gasPrice, nativeToken } = multiProvider.getChainMetadata(
          chain,
        ) as any;

        const minBalanceSmallestUnit = new BigNumber(
          GasPrice.fromString(gasPrice).amount.toString(),
        )
          .multipliedBy(minGas[ProtocolType.Cosmos])
          .toString();
        const minBalance = new BigNumber(minBalanceSmallestUnit)
          .dividedBy(new BigNumber(10).exponentiatedBy(nativeToken.decimals))
          .toString();

        const balanceSmallestUnit = (
          await provider.getBalance(address, nativeToken.denom)
        ).amount;
        const balance = new BigNumber(balanceSmallestUnit)
          .dividedBy(new BigNumber(10).exponentiatedBy(nativeToken.decimals))
          .toString();

        if (new BigNumber(balanceSmallestUnit).lt(minBalanceSmallestUnit)) {
          logRed(
            `WARNING: ${address} has low balance on ${chain}. At least ${minBalance} ${nativeToken.symbol} recommended but found ${balance} ${nativeToken.symbol}`,
          );
          sufficientBalances.push(false);
        }
        break;
      }
      default: {
        logGray(`Skipping balance check for unsupported chain: ${chain}`);
      }
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
