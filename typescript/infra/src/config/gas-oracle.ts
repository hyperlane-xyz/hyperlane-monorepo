import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  GasPriceConfig,
  StorageGasOracleConfig,
  TOKEN_EXCHANGE_RATE_SCALE,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';

import { isEthereumProtocolChain } from '../utils/utils.js';

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
  gasPrices: ChainMap<GasPriceConfig>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
  getTokenUsdPrice?: (chain: ChainName) => number,
  getOverhead?: (local: ChainName, remote: ChainName) => number,
): ChainMap<StorageGasOracleConfig> {
  return remotes.reduce((agg, remote) => {
    let exchangeRate = getTokenExchangeRate(local, remote);
    if (!gasPrices[remote]) {
      // Will run into this case when adding new chains
      console.warn(chalk.yellow(`No gas price set for ${remote}`));
      return agg;
    }

    // First parse as a number, so we have floating point precision.
    // Recall it's possible to have gas prices that are not integers, even
    // after converting to the "wei" version of the token.
    let gasPrice =
      parseFloat(gasPrices[remote].amount) *
      Math.pow(10, gasPrices[remote].decimals);
    if (isNaN(gasPrice)) {
      throw new Error(
        `Invalid gas price for chain ${remote}: ${gasPrices[remote]}`,
      );
    }

    // We have very little precision and ultimately need an integer value for
    // the gas price that will be set on-chain. We scale up the gas price and
    // scale down the exchange rate by the same factor.
    if (gasPrice < 10 && gasPrice % 1 !== 0) {
      // Scale up the gas price by 1e4
      const gasPriceScalingFactor = 1e4;

      // Check that there's no significant underflow when applying
      // this to the exchange rate:
      const adjustedExchangeRate = exchangeRate.div(gasPriceScalingFactor);
      const recoveredExchangeRate = adjustedExchangeRate.mul(
        gasPriceScalingFactor,
      );
      if (recoveredExchangeRate.mul(100).div(exchangeRate).lt(99)) {
        throw new Error('Too much underflow when downscaling exchange rate');
      }

      // Apply the scaling factor
      exchangeRate = adjustedExchangeRate;
      gasPrice *= gasPriceScalingFactor;
    }

    // Our integer gas price.
    let gasPriceBn = BigNumber.from(Math.ceil(gasPrice));

    // If we have access to these, let's use the USD prices to apply some minimum
    // typical USD payment heuristics.
    if (getTokenUsdPrice && getOverhead) {
      const typicalRemoteGasAmount = getTypicalRemoteGasAmount(
        local,
        remote,
        getOverhead,
      );
      const typicalIgpQuoteUsd = getUsdQuote(
        local,
        gasPriceBn,
        exchangeRate,
        typicalRemoteGasAmount,
        getTokenUsdPrice,
      );

      const minUsdCost = getMinUsdCost(local, remote);
      if (typicalIgpQuoteUsd < minUsdCost) {
        // Adjust the gasPrice to meet the minimum cost
        const minIgpQuote = ethers.utils.parseEther(
          (minUsdCost / getTokenUsdPrice(local)).toPrecision(8),
        );
        gasPriceBn = minIgpQuote
          .mul(TOKEN_EXCHANGE_RATE_SCALE)
          .div(exchangeRate.mul(typicalRemoteGasAmount));
      }
    }

    return {
      ...agg,
      [remote]: {
        tokenExchangeRate: exchangeRate,
        gasPrice: gasPriceBn,
      },
    };
  }, {});
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
  local: ChainName,
  gasPrice: BigNumber,
  exchangeRate: BigNumber,
  remoteGasAmount: number,
  getTokenUsdPrice: (chain: ChainName) => number,
): number {
  const quote = gasPrice
    .mul(exchangeRate)
    .mul(remoteGasAmount)
    .div(TOKEN_EXCHANGE_RATE_SCALE);
  const quoteUsd =
    getTokenUsdPrice(local) * parseFloat(ethers.utils.formatEther(quote));

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
  gasPrices: ChainMap<GasPriceConfig>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
  getTokenUsdPrice?: (chain: ChainName) => number,
  getOverhead?: (local: ChainName, remote: ChainName) => number,
): AllStorageGasOracleConfigs {
  return chainNames.filter(isEthereumProtocolChain).reduce((agg, local) => {
    const remotes = chainNames.filter((chain) => local !== chain);
    return {
      ...agg,
      [local]: getLocalStorageGasOracleConfigOverride(
        local,
        remotes,
        gasPrices,
        getTokenExchangeRate,
        getTokenUsdPrice,
        getOverhead,
      ),
    };
  }, {}) as AllStorageGasOracleConfigs;
}
