import { BigNumber as BigNumberJs } from 'bignumber.js';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  ChainGasOracleParams,
  ChainMap,
  ChainName,
  GasPriceConfig,
  ProtocolAgnositicGasOracleConfig,
  StorageGasOracleConfig,
  defaultMultisigConfigs,
  getLocalStorageGasOracleConfig,
  getProtocolSpecificExchangeRateScale,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  convertDecimals,
  convertDecimalsIntegerString,
  fromWei,
  toWei,
} from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';
import {
  isEthereumProtocolChain,
  mustGetChainNativeToken,
} from '../utils/utils.js';

// gas oracle configs for each chain, which includes
// a map for each chain's remote chains
export type AllStorageGasOracleConfigs = ChainMap<
  ChainMap<StorageGasOracleConfig>
>;

// Overcharge by 50% to account for market making risk
export const EXCHANGE_RATE_MARGIN_PCT = 50;

// Arbitrarily chosen as a typical amount of gas used in a message's handle function.
// Used for determining typical gas costs for a message.
export const TYPICAL_HANDLE_GAS_USAGE = 50_000;

// Gets the StorageGasOracleConfig for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
function getLocalStorageGasOracleConfigOverride(
  local: ChainName,
  remotes: ChainName[],
  tokenPrices: ChainMap<string>,
  gasPrices: ChainMap<GasPriceConfig>,
  getOverhead?: (local: ChainName, remote: ChainName) => number,
): ChainMap<StorageGasOracleConfig> {
  const localProtocolType = getChain(local).protocol;
  const localExchangeRateScale =
    getProtocolSpecificExchangeRateScale(localProtocolType);
  const localNativeTokenDecimals = mustGetChainNativeToken(local).decimals;

  const gasOracleParams = [local, ...remotes].reduce((agg, remote) => {
    agg[remote] = {
      gasPrice: gasPrices[remote],
      nativeToken: {
        price: tokenPrices[remote],
        decimals: mustGetChainNativeToken(remote).decimals,
      },
    };
    return agg;
  }, {} as ChainMap<ChainGasOracleParams>);

  const gasPriceModifier = (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ): BigNumberJs.Value => {
    if (getOverhead) {
      const typicalRemoteGasAmount = getTypicalRemoteGasAmount(
        local,
        remote,
        getOverhead,
      );
      const localTokenUsdPrice = parseFloat(tokenPrices[local]);
      const typicalIgpQuoteUsd = getUsdQuote(
        localTokenUsdPrice,
        localExchangeRateScale,
        localNativeTokenDecimals,
        localProtocolType,
        gasOracleConfig,
        typicalRemoteGasAmount,
      );

      const minUsdCost = getMinUsdCost(local, remote);
      if (typicalIgpQuoteUsd < minUsdCost) {
        // Adjust the gasPrice to meet the minimum cost
        const minIgpQuoteWei = toWei(
          new BigNumberJs(minUsdCost).div(localTokenUsdPrice),
          localNativeTokenDecimals,
        );
        console.log('minIgpQuoteWei', minIgpQuoteWei);
        let newGasPrice = new BigNumberJs(minIgpQuoteWei)
          .times(localExchangeRateScale.toString())
          .div(
            new BigNumberJs(gasOracleConfig.tokenExchangeRate).times(
              typicalRemoteGasAmount,
            ),
          );
        console.log('newGasPrice', newGasPrice);
        if (localProtocolType === ProtocolType.Sealevel) {
          // On Sealevel, the exchange rate doesn't consider decimals.
          // We therefor explicitly convert decimals to remote decimals.
          newGasPrice = convertDecimals(
            localNativeTokenDecimals,
            gasOracleConfig.tokenDecimals,
            newGasPrice.toString(),
          );
          // assert(newGasPrice.gt(0), 'newGasPrice must be greater than 0');
          return newGasPrice;
        }
      }
    }
    return gasOracleConfig.gasPrice;
  };

  return getLocalStorageGasOracleConfig({
    local,
    localProtocolType,
    gasOracleParams,
    exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
    gasPriceModifier,
  });
}

export function getTypicalRemoteGasAmount(
  local: ChainName,
  remote: ChainName,
  getOverhead: (local: ChainName, remote: ChainName) => number,
): number {
  return getOverhead(local, remote) + TYPICAL_HANDLE_GAS_USAGE;
}

function getMinUsdCost(local: ChainName, remote: ChainName): number {
  // By default, min cost is 20 cents
  let minUsdCost = 0.2;

  // For Ethereum local, min cost is 1.5 USD
  if (local === 'ethereum') {
    minUsdCost = Math.max(minUsdCost, 1.5);
  }

  const remoteMinCostOverrides: ChainMap<number> = {
    // For Ethereum L2s, we need to account for the L1 DA costs that
    // aren't accounted for directly in the gas price.
    arbitrum: 0.5,
    ancient8: 0.5,
    base: 0.5,
    blast: 0.5,
    bob: 0.5,
    fraxtal: 0.5,
    linea: 0.5,
    mantapacific: 0.5,
    mantle: 0.5,
    mode: 0.5,
    optimism: 0.5,
    polygonzkevm: 0.5,
    // Scroll is more expensive than the rest due to higher L1 fees
    scroll: 1.5,
    taiko: 0.5,
    // Nexus adjustment
    neutron: 0.5,
  };
  const override = remoteMinCostOverrides[remote];
  if (override !== undefined) {
    minUsdCost = Math.max(minUsdCost, override);
  }

  return minUsdCost;
}

function getUsdQuote(
  localTokenUsdPrice: number,
  localExchangeRateScale: BigNumber,
  localNativeTokenDecimals: number,
  localProtocolType: ProtocolType,
  gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  remoteGasAmount: number,
): number {
  let quote = BigNumber.from(gasOracleConfig.gasPrice)
    .mul(gasOracleConfig.tokenExchangeRate)
    .mul(remoteGasAmount)
    .div(localExchangeRateScale)
    .toString();
  if (localProtocolType === ProtocolType.Sealevel) {
    // Convert decimals to local decimals
    quote = convertDecimals(
      gasOracleConfig.tokenDecimals,
      localNativeTokenDecimals,
      quote,
    ).toString();
  }
  const quoteUsd =
    localTokenUsdPrice * parseFloat(fromWei(quote, localNativeTokenDecimals));

  return quoteUsd;
}

// cosmwasm warp route somewhat arbitrarily chosen
const FOREIGN_DEFAULT_OVERHEAD = 600_000;

// Overhead for interchain messaging
export function getOverhead(
  local: ChainName,
  remote: ChainName,
  ethereumChainNames: ChainName[],
): number {
  return ethereumChainNames.includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[local].threshold,
        defaultMultisigConfigs[local].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead
}

// Gets the map of remote gas oracle configs for each local chain
export function getAllStorageGasOracleConfigs(
  chainNames: ChainName[],
  tokenPrices: ChainMap<string>,
  gasPrices: ChainMap<GasPriceConfig>,
  getOverhead?: (local: ChainName, remote: ChainName) => number,
): AllStorageGasOracleConfigs {
  // return chainNames.filter(isEthereumProtocolChain).

  return chainNames
    .filter((chain) => {
      // For now, only support Ethereum and Sealevel chains.
      // Cosmos chains should be supported in the future, but at the moment
      // are more subject to loss of precision issues in the exchange rate,
      // where we'd need to scale the gas price accordingly.
      const protocol = getChain(chain).protocol;
      return (
        protocol === ProtocolType.Ethereum || protocol === ProtocolType.Sealevel
      );
    })
    .reduce((agg, local) => {
      const remotes = chainNames.filter((chain) => local !== chain);
      return {
        ...agg,
        [local]: getLocalStorageGasOracleConfigOverride(
          local,
          remotes,
          tokenPrices,
          gasPrices,
          getOverhead,
        ),
      };
    }, {}) as AllStorageGasOracleConfigs;
}
