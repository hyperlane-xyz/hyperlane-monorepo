<<<<<<< HEAD
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
=======
import { BigNumber as BN } from 'bignumber.js';
import { BigNumber } from 'ethers';
import { formatUnits } from 'ethers/lib/utils.js';

import {
  AnyProtocolReceipt,
  AnyProtocolTransaction,
  ChainName,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  AltVM,
  GasAction,
  ProtocolType,
  assert,
} from '@hyperlane-xyz/utils';

import { autoConfirm } from '../config/prompts.js';
import { ETHEREUM_MINIMUM_GAS } from '../consts.js';
import { logBlue, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  altVmSigner: AltVM.ISignerFactory<AnyProtocolTransaction, AnyProtocolReceipt>,
  chains: ChainName[],
  minGas: GasAction,
>>>>>>> main
  skipConfirmation: boolean,
) {
  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
<<<<<<< HEAD
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
=======
    const protocolType = multiProvider.getProtocol(chain);

    const symbol = multiProvider.getChainMetadata(chain).nativeToken?.symbol;
    assert(symbol, `no symbol found for native token on chain ${chain}`);

    let address: Address = '';
    let requiredMinBalanceNativeDenom = BigNumber.from(0);
    let requiredMinBalance: string = '0';

    let deployerBalanceNativeDenom = BigNumber.from(0);
    let deployerBalance: string = '0';

    switch (protocolType) {
      case ProtocolType.Ethereum: {
        address = await multiProvider.getSignerAddress(chain);

        const provider = multiProvider.getProvider(chain);
        const gasPrice = await provider.getGasPrice();

        requiredMinBalanceNativeDenom = gasPrice.mul(
          ETHEREUM_MINIMUM_GAS[minGas],
        );
        requiredMinBalance = formatUnits(
          requiredMinBalanceNativeDenom.toString(),
        );

        deployerBalanceNativeDenom = await provider.getBalance(address);
        deployerBalance = formatUnits(deployerBalanceNativeDenom.toString());
        break;
      }
      default: {
        const signer = altVmSigner.get(chain);

        address = signer.getSignerAddress();

        const { gasPrice, nativeToken, protocol } =
          multiProvider.getChainMetadata(chain);
>>>>>>> main

        assert(nativeToken, `nativeToken is not defined on chain ${chain}`);
        assert(
          nativeToken.denom,
          `nativeToken denom is not defined on chain ${chain}`,
        );
<<<<<<< HEAD
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
=======

        if (!gasPrice) {
          return;
        }

        const ALT_VM_GAS = altVmSigner.getMinGas(protocol);
        requiredMinBalanceNativeDenom = BigNumber.from(
          new BN(gasPrice.amount)
            .times(ALT_VM_GAS[minGas].toString())
            .toFixed(0),
        );
        requiredMinBalance = formatUnits(
          requiredMinBalanceNativeDenom,
          nativeToken.decimals,
        );

        deployerBalanceNativeDenom = BigNumber.from(
          await signer.getBalance({ address, denom: nativeToken.denom }),
        );
        deployerBalance = formatUnits(
          deployerBalanceNativeDenom,
          nativeToken.decimals,
        );
      }
    }

    if (deployerBalanceNativeDenom.lt(requiredMinBalanceNativeDenom)) {
>>>>>>> main
      logRed(
        `WARNING: ${address} has low balance on ${chain}. At least ${requiredMinBalance} ${symbol} recommended but found ${deployerBalance} ${symbol}`,
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
