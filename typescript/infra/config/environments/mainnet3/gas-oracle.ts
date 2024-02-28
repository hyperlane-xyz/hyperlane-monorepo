import { BigNumber, ethers } from 'ethers';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config';
import {
  TOKEN_EXCHANGE_RATE_DECIMALS,
  getTokenExchangeRateFromValues,
} from '../../../src/config/gas-oracle';

import { supportedChainNames } from './chains';
import rawGasPrices from './gasPrices.json';
import rawTokenPrices from './tokenPrices.json';

const gasPrices: ChainMap<BigNumber> = objMap(rawGasPrices, (_, gasPrice) =>
  ethers.utils.parseUnits(gasPrice, 'gwei'),
);

const tokenUsdPrices: ChainMap<BigNumber> = objMap(
  rawTokenPrices,
  (_, tokenUsdPrice) =>
    ethers.utils.parseUnits(tokenUsdPrice, TOKEN_EXCHANGE_RATE_DECIMALS),
);

// Gets the exchange rate of the remote quoted in local tokens
function getTokenExchangeRate(local: ChainName, remote: ChainName): BigNumber {
  const localValue = tokenUsdPrices[local];
  const remoteValue = tokenUsdPrices[remote];

  return getTokenExchangeRateFromValues(local, localValue, remote, remoteValue);
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    getTokenExchangeRate,
  );
