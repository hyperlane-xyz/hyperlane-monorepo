import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  StorageGasOracleConfig as DestinationOracleConfig,
  TOKEN_EXCHANGE_RATE_SCALE,
  chainMetadata,
  getCosmosRegistryChain,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, convertDecimals } from '@hyperlane-xyz/utils';

import { mustGetChainNativeToken } from '../utils/utils.js';

// Gas data to configure on a single local chain. Includes DestinationOracleConfig
// for each remote chain.
export type StorageGasOracleConfig = ChainMap<DestinationOracleConfig>;

// StorageGasOracleConfigs for each local chain
export type AllStorageGasOracleConfigs = ChainMap<StorageGasOracleConfig>;

// A configuration for a gas price.
// Some chains, e.g. Neutron, have gas prices that are
// not integers and and are still quoted in the "wei" version
// of the token. Therefore it's possible for the amount to be a
// float (e.g. "0.0053") and for decimals to be 1. This is why
// we intentionally don't deal with BigNumber here.
export interface GasPriceConfig {
  amount: string;
  decimals: number;
}

// Overcharge by 50% to account for market making risk
const EXCHANGE_RATE_MARGIN_PCT = 50;

const ETH_L2_GAS_PRICE_OVERHEAD = ethers.utils.parseUnits('1', 'gwei');

// Gets the StorageGasOracleConfig for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
function getLocalStorageGasOracleConfig(
  local: ChainName,
  remotes: ChainName[],
  gasPrices: ChainMap<GasPriceConfig>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
): StorageGasOracleConfig {
  return remotes.reduce((agg, remote) => {
    let exchangeRate = getTokenExchangeRate(local, remote);
    if (!gasPrices[remote]) {
      throw new Error(`No gas price found for chain ${remote}`);
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

    const ethL2s = [
      'scroll',
      'base',
      'optimism',
      'arbitrum',
      'inevm',
      'ancient8',
      'mantapacific',
      'polygonzkevm',
    ];
    if (ethL2s.includes(remote)) {
      gasPriceBn = gasPriceBn.add(ETH_L2_GAS_PRICE_OVERHEAD);
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

// Gets the StorageGasOracleConfig for each local chain
export function getAllStorageGasOracleConfigs(
  chainNames: ChainName[],
  gasPrices: ChainMap<GasPriceConfig>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
): AllStorageGasOracleConfigs {
  return chainNames.reduce((agg, local) => {
    const remotes = chainNames.filter((chain) => local !== chain);
    return {
      ...agg,
      [local]: getLocalStorageGasOracleConfig(
        local,
        remotes,
        gasPrices,
        getTokenExchangeRate,
      ),
    };
  }, {}) as AllStorageGasOracleConfigs;
}

export function getTokenExchangeRateFromValues(
  local: ChainName,
  localValue: BigNumber,
  remote: ChainName,
  remoteValue: BigNumber,
): BigNumber {
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

export async function getCosmosChainGasPrice(
  chain: ChainName,
): Promise<number> {
  const metadata = chainMetadata[chain];
  if (!metadata) {
    throw new Error(`No metadata found for Cosmos chain ${chain}`);
  }
  if (metadata.protocol !== ProtocolType.Cosmos) {
    throw new Error(`Chain ${chain} is not a Cosmos chain`);
  }

  const cosmosRegistryChain = await getCosmosRegistryChain(chain);

  const nativeToken = mustGetChainNativeToken(chain);

  const fee = cosmosRegistryChain.fees?.fee_tokens.find((fee) => {
    return (
      fee.denom === nativeToken.denom || fee.denom === `u${nativeToken.denom}`
    );
  });
  if (!fee || fee.average_gas_price === undefined) {
    throw new Error(`No gas price found for Cosmos chain ${chain}`);
  }

  return fee.average_gas_price;
}
