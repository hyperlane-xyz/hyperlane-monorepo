import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  GasPriceConfig,
  TOKEN_EXCHANGE_RATE_DECIMALS,
} from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config/gas-oracle.js';

import { testChainNames } from './chains.js';

const TEST_TOKEN_EXCHANGE_RATE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);
const TEST_GAS_PRICE_CONFIG: GasPriceConfig = {
  amount: '2',
  decimals: 9, // gwei
};

const gasPrices: ChainMap<GasPriceConfig> = {
  test1: TEST_GAS_PRICE_CONFIG,
  test2: TEST_GAS_PRICE_CONFIG,
  test3: TEST_GAS_PRICE_CONFIG,
};

function getTokenExchangeRate(
  _local: ChainName,
  _remote: ChainName,
): BigNumber {
  return TEST_TOKEN_EXCHANGE_RATE;
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    testChainNames,
    gasPrices,
    getTokenExchangeRate,
  );
