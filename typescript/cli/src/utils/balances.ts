import { BigNumber as BN } from 'bignumber.js';
import { BigNumber } from 'ethers';
import { formatUnits } from 'ethers/lib/utils.js';

import {
  type AltVM,
  GasAction,
  ProtocolType,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { type WarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import {
  type ChainMap,
  type ChainName,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, mustGet } from '@hyperlane-xyz/utils';

import { autoConfirm } from '../config/prompts.js';
import { ETHEREUM_MINIMUM_GAS } from '../consts.js';
import { logBlue, logGreen, logRed, warnYellow } from '../logger.js';

export async function nativeBalancesAreSufficient(
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  chains: ChainName[],
  minGas: GasAction,
  skipConfirmation: boolean,
  // When `minGas === GasAction.WARP_DEPLOY_GAS` and a per-chain WarpConfig is
  // available, the AltVM branch consults `getMinGasForWarpDeploy(warpConfig)`
  // instead of the flat `getMinGas().WARP_DEPLOY_GAS` — the flat value only
  // sizes the base router case and under-funds feature-heavy deploys
  // (cross-collateral, fee program, custom ISM/hook).
  warpConfigByChain?: ChainMap<WarpConfig>,
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
      case ProtocolType.Tron:
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
        const signer = mustGet(altVmSigners, chain);
        address = signer.getSignerAddress();

        const { gasPrice, nativeToken, protocol } =
          multiProvider.getChainMetadata(chain);

        assert(nativeToken, `nativeToken is not defined on chain ${chain}`);
        assert(
          nativeToken.denom,
          `nativeToken denom is not defined on chain ${chain}`,
        );

        if (!gasPrice) {
          return;
        }

        const protocolProvider = getProtocolProvider(protocol);
        const warpConfig = warpConfigByChain?.[chain];
        const requiredGasUnits =
          minGas === GasAction.WARP_DEPLOY_GAS && warpConfig
            ? protocolProvider.getMinGasForWarpDeploy(warpConfig)
            : protocolProvider.getMinGas()[minGas];
        requiredMinBalanceNativeDenom = BigNumber.from(
          new BN(gasPrice.amount).times(requiredGasUnits.toString()).toFixed(0),
        );
        requiredMinBalance = formatUnits(
          requiredMinBalanceNativeDenom,
          nativeToken.decimals,
        );

        deployerBalanceNativeDenom = BigNumber.from(
          await signer.getBalance({
            address,
            denom: nativeToken.denom,
          }),
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
