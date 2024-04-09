import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  StorageGasOracleConfig as DestinationOracleConfig,
} from '@hyperlane-xyz/sdk';
import { convertDecimals } from '@hyperlane-xyz/utils';

import { mustGetChainNativeTokenDecimals } from '../utils/utils.js';

// Gas data to configure on a single local chain. Includes DestinationOracleConfig
// for each remote chain.
export type StorageGasOracleConfig = ChainMap<DestinationOracleConfig>;

// StorageGasOracleConfigs for each local chain
export type AllStorageGasOracleConfigs = ChainMap<StorageGasOracleConfig>;

export const TOKEN_EXCHANGE_RATE_DECIMALS = 10;
export const TOKEN_EXCHANGE_RATE_SCALE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

// Overcharge by 20% to account for market making risk (when assets are unequal)
const EXCHANGE_RATE_MARGIN_PCT = 20;

// Gets the StorageGasOracleConfig for a particular local chain
function getLocalStorageGasOracleConfig(
  local: ChainName,
  remotes: ChainName[],
  gasPrices: ChainMap<BigNumber>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
): StorageGasOracleConfig {
  return remotes.reduce((agg, remote) => {
    const exchangeRate = getTokenExchangeRate(local, remote);
    return {
      ...agg,
      [remote]: {
        tokenExchangeRate: exchangeRate,
        gasPrice: gasPrices[remote],
      },
    };
  }, {});
}

// Gets the StorageGasOracleConfig for each local chain
export function getAllStorageGasOracleConfigs(
  chainNames: ChainName[],
  gasPrices: ChainMap<BigNumber>,
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
  // use margin if exchange rate is not 1
  if (!exchangeRate.eq(TOKEN_EXCHANGE_RATE_SCALE)) {
    exchangeRate = exchangeRate.mul(100 + EXCHANGE_RATE_MARGIN_PCT).div(100);
  }

  return BigNumber.from(
    convertDecimals(
      mustGetChainNativeTokenDecimals(remote),
      mustGetChainNativeTokenDecimals(local),
      exchangeRate.toString(),
    ),
  );
}
