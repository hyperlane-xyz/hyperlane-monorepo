import { GasPrice } from '@cosmjs/stargate';
import { BigNumber } from 'ethers';
import { formatUnits, parseUnits } from 'ethers/lib/utils.js';

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
    let requiredMinBalanceNativeDenom = BigNumber.from(0);
    let requiredMinBalance: string = '0';

    let deployerBalanceNativeDenom = BigNumber.from(0);
    let deployerBalance: string = '0';

    switch (protocolType) {
      case ProtocolType.Ethereum: {
        address = await multiProtocolSigner.getEVMSigner(chain).getAddress();

        const provider = multiProtocolProvider.getEthersV5Provider(chain);
        const gasPrice = await provider.getGasPrice();

        requiredMinBalanceNativeDenom = gasPrice.mul(
          minGas[ProtocolType.Ethereum],
        );
        requiredMinBalance = formatUnits(
          requiredMinBalanceNativeDenom.toString(),
        );

        deployerBalanceNativeDenom = await provider.getBalance(address);
        deployerBalance = formatUnits(deployerBalanceNativeDenom.toString());
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

        const gasPriceInNativeDenom = parseUnits(
          GasPrice.fromString(
            `${gasPrice.amount}${gasPrice.denom}`,
          ).amount.toString(),
          nativeToken.decimals,
        );
        requiredMinBalanceNativeDenom = gasPriceInNativeDenom.mul(
          minGas[ProtocolType.CosmosNative],
        );
        requiredMinBalance = formatUnits(
          requiredMinBalanceNativeDenom,
          nativeToken.decimals,
        );

        deployerBalanceNativeDenom = BigNumber.from(
          (await provider.getBalance(address, nativeToken.denom)).amount,
        );
        deployerBalance = formatUnits(
          deployerBalanceNativeDenom,
          nativeToken.decimals,
        );
        break;
      }
      default: {
        logGray(`Skipping balance check for unsupported chain: ${chain}`);
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
