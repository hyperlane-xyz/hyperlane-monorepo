import { GasPrice } from '@cosmjs/stargate';
import { BigNumber } from 'ethers';
import { formatUnits, parseUnits } from 'ethers/lib/utils.js';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  Address,
  MINIMUM_GAS_ACTION,
  ProtocolType,
  assert,
} from '@hyperlane-xyz/utils';

import { IMultiVMSignerFactory } from '../../../utils/dist/multivm.js';
import { autoConfirm } from '../config/prompts.js';
import { ETHEREUM_MINIMUM_GAS } from '../consts.js';
import { logBlue, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  multiVmSigners: IMultiVMSignerFactory,
  chains: ChainName[],
  minGas: MINIMUM_GAS_ACTION,
  skipConfirmation: boolean,
) {
  const sufficientBalances: boolean[] = [];
  for (const chain of chains) {
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
        const signer = multiVmSigners.get(chain);

        address = signer.getSignerAddress();

        const { gasPrice, nativeToken, protocol } =
          multiProvider.getChainMetadata(chain);

        assert(nativeToken, `nativeToken is not defined on chain ${chain}`);
        assert(
          nativeToken.denom,
          `nativeToken denom is not defined on chain ${chain}`,
        );
        assert(gasPrice, `gasPrice is not defined on chain ${chain}`);

        const gasPriceInNativeDenom = parseUnits(
          GasPrice.fromString(
            `${gasPrice.amount}${gasPrice.denom}`,
          ).amount.toString(),
          nativeToken.decimals,
        );
        const MULTI_VM_GAS = multiVmSigners.getGas(protocol);
        requiredMinBalanceNativeDenom = gasPriceInNativeDenom.mul(
          MULTI_VM_GAS[minGas],
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
