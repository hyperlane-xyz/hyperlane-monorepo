import { BigNumber, ethers } from 'ethers';

import { convertDecimals } from '@hyperlane-xyz/utils';

import { getChainNativeTokenDecimals } from '../consts/chainMetadata';
import {
  GasOracleContractType,
  StorageGasOraclesConfig,
} from '../gas/oracle/types';
import { ChainMap, ChainName } from '../types';

export const TOKEN_EXCHANGE_RATE_DECIMALS = 10;
export const TOKEN_EXCHANGE_RATE_SCALE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

// Overcharge by 30% to account for market making risk
const TOKEN_EXCHANGE_RATE_MULTIPLIER = ethers.utils.parseUnits(
  '1.30',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);

// Gets the StorageGasOracleConfig for a particular local chain
function getLocalStorageGasOracleConfig(
  local: ChainName,
  remotes: ChainName[],
  gasPrices: ChainMap<BigNumber>,
  getTokenExchangeRate: (local: ChainName, remote: ChainName) => BigNumber,
): StorageGasOraclesConfig {
  return remotes.reduce((agg, remote) => {
    const exchangeRate = getTokenExchangeRate(local, remote);
    return {
      ...agg,
      [remote]: {
        type: GasOracleContractType.StorageGasOracle,
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
): ChainMap<StorageGasOraclesConfig> {
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
  }, {});
}

export function getTokenExchangeRateFromValues(
  local: ChainName,
  localValue: BigNumber,
  remote: ChainName,
  remoteValue: BigNumber,
): BigNumber {
  // This does not yet account for decimals!
  const exchangeRate = remoteValue
    .mul(TOKEN_EXCHANGE_RATE_MULTIPLIER)
    .div(localValue);

  return BigNumber.from(
    convertDecimals(
      getChainNativeTokenDecimals(remote),
      getChainNativeTokenDecimals(local),
      exchangeRate.toString(),
    ),
  );
}
