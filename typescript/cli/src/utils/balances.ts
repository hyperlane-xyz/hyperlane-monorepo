import { GasPrice } from '@cosmjs/stargate';
import { BigNumber } from 'bignumber.js';
import { ethers } from 'ethers';

import {
  ChainMetadataManager,
  ChainName,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { autoConfirm } from '../config/prompts.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { logBlue, logGray, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  metadataManager: ChainMetadataManager,
  multiProtocolProvider: MultiProtocolProvider,
  multiProtocolSigner: MultiProtocolSignerManager,
  chains: ChainName[],
  minGas: typeof MINIMUM_WARP_DEPLOY_GAS,
  skipConfirmation: boolean,
) {
  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
    const protocolType = metadataManager.getProtocol(chain);

    const symbol = metadataManager.getChainMetadata(chain).nativeToken?.symbol;
    assert(symbol, `no symbol found for native token on chain ${chain}`);

    let address: Address = '';
    let minBalanceSmallestUnit = new BigNumber(0);
    let minBalance = new BigNumber(0);

    let balanceSmallestUnit = new BigNumber(0);
    let balance = new BigNumber(0);

    switch (protocolType) {
      case ProtocolType.Ethereum: {
        address = await multiProtocolSigner.getEVMSigner(chain).getAddress();

        const provider = multiProtocolProvider.getEthersV5Provider(chain);
        const gasPrice = await provider.getGasPrice();

        minBalanceSmallestUnit = new BigNumber(
          gasPrice.mul(minGas[ProtocolType.Ethereum]).toString(),
        );
        minBalance = new BigNumber(
          ethers.utils.formatEther(minBalanceSmallestUnit.toString()),
        );

        balanceSmallestUnit = new BigNumber(
          (await provider.getBalance(address)).toString(),
        );
        balance = new BigNumber(
          ethers.utils.formatEther(balanceSmallestUnit.toFixed()).toString(),
        );
        break;
      }
      case ProtocolType.CosmosNative: {
        address =
          multiProtocolSigner.getCosmosNativeSigner(chain).account.address;

        const provider = await multiProtocolProvider.getCosmJsProvider(chain);
        const { gasPrice, nativeToken } =
          metadataManager.getChainMetadata(chain);

        assert(nativeToken, `nativeToken is not defined on chain ${chain}`);
        assert(
          nativeToken.denom,
          `nativeToken denom is not defined on chain ${chain}`,
        );
        assert(gasPrice, `gasPrice is not defined on chain ${chain}`);

        minBalanceSmallestUnit = new BigNumber(
          GasPrice.fromString(
            `${gasPrice.amount}${gasPrice.denom}`,
          ).amount.toString(),
        ).multipliedBy(minGas[ProtocolType.CosmosNative]);
        minBalance = new BigNumber(minBalanceSmallestUnit).dividedBy(
          new BigNumber(10).exponentiatedBy(nativeToken.decimals),
        );

        balanceSmallestUnit = new BigNumber(
          (await provider.getBalance(address, nativeToken.denom)).amount,
        );
        balance = new BigNumber(balanceSmallestUnit).dividedBy(
          new BigNumber(10).exponentiatedBy(nativeToken.decimals),
        );
        break;
      }
      default: {
        logGray(`Skipping balance check for unsupported chain: ${chain}`);
      }
    }

    if (new BigNumber(balanceSmallestUnit).lt(minBalanceSmallestUnit)) {
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
