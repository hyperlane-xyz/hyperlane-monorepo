import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  AgentCosmosGasPrice,
  ChainMap,
  ChainName,
  StorageGasOracleConfig as DestinationOracleConfig,
  TOKEN_EXCHANGE_RATE_DECIMALS,
  TOKEN_EXCHANGE_RATE_SCALE,
  defaultMultisigConfigs,
  getCosmosRegistryChain,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, convertDecimals } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';
import {
  isEthereumProtocolChain,
  mustGetChainNativeToken,
} from '../utils/utils.js';

// Gas data to configure on a single local chain. Includes DestinationOracleConfig
// for each remote chain.
export type StorageGasOracleConfig = ChainMap<DestinationOracleConfig>;

// StorageGasOracleConfigs for each local chain
export type AllStorageGasOracleConfigs = ChainMap<StorageGasOracleConfig>;

// A configuration for a gas price.
// Some chains, e.g. Neutron, have gas prices that are
// not integers and are still quoted in the "wei" version
// of the token. Therefore, it's possible for the amount to be a
// float (e.g. "0.0053") and for decimals to be 1. This is why
// we intentionally don't deal with BigNumber here.
export interface GasPriceConfig {
  amount: string;
  decimals: number;
}

// Overcharge by 50% to account for market making risk
const EXCHANGE_RATE_MARGIN_PCT = 50;

// Gets the StorageGasOracleConfig for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
function getLocalStorageGasOracleConfig(
  local: ChainName,
  remotes: ChainName[],
  gasPrices: ChainMap<GasPriceConfig>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
  getTokenUsdPrice?: (chain: ChainName) => number,
  getOverhead?: (local: ChainName, remote: ChainName) => number,
): StorageGasOracleConfig {
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
      const typicalRemoteGasAmount = getOverhead(local, remote) + 50_000;
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

// Gets the StorageGasOracleConfig for each local chain
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
      [local]: getLocalStorageGasOracleConfig(
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

// Gets the exchange rate of the remote quoted in local tokens
export function getTokenExchangeRateFromValues(
  local: ChainName,
  remote: ChainName,
  tokenPrices: ChainMap<string>,
): BigNumber {
  // Workaround for chicken-egg dependency problem.
  // We need to provide some default value here to satisfy the config on initial load,
  // whilst knowing that it will get overwritten when a script actually gets run.
  if (!tokenPrices[local] || !tokenPrices[remote]) {
    return BigNumber.from(1);
  }

  const localValue = ethers.utils.parseUnits(
    tokenPrices[local],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );
  const remoteValue = ethers.utils.parseUnits(
    tokenPrices[remote],
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );

  // This does not yet account for decimals!
  let exchangeRate = remoteValue.mul(TOKEN_EXCHANGE_RATE_SCALE).div(localValue);
  // Apply the premium
  exchangeRate = exchangeRate.mul(100 + EXCHANGE_RATE_MARGIN_PCT).div(100);

  return BigNumber.from(
    convertDecimals(
      mustGetChainNativeToken(remote).decimals,
      mustGetChainNativeToken(local).decimals,
      exchangeRate.toString(),
    ),
  );
}

// Gets the gas price for a Cosmos chain
export async function getCosmosChainGasPrice(
  chain: ChainName,
): Promise<AgentCosmosGasPrice> {
  const metadata = getChain(chain);
  if (!metadata) {
    throw new Error(`No metadata found for Cosmos chain ${chain}`);
  }
  if (metadata.protocol !== ProtocolType.Cosmos) {
    throw new Error(`Chain ${chain} is not a Cosmos chain`);
  }

  const cosmosRegistryChain = await getCosmosRegistryChain(chain);

  const nativeToken = mustGetChainNativeToken(chain);

  const fee = cosmosRegistryChain.fees?.fee_tokens.find(
    (fee: { denom: string }) => {
      return (
        fee.denom === nativeToken.denom || fee.denom === `u${nativeToken.denom}`
      );
    },
  );
  if (!fee || fee.average_gas_price === undefined) {
    throw new Error(`No gas price found for Cosmos chain ${chain}`);
  }

  return {
    denom: fee.denom,
    amount: fee.average_gas_price.toString(),
  };
}
