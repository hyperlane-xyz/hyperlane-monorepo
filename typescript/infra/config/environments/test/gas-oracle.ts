import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  TOKEN_EXCHANGE_RATE_EXPONENT,
} from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  GasPriceConfig,
  getAllStorageGasOracleConfigs,
} from '../../../src/config/gas-oracle.js';

import { chainNames } from './chains.js';

const TEST_TOKEN_EXCHANGE_RATE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_EXPONENT,
);
const TEST_GAS_PRICE = ethers.utils.parseUnits('2', 'gwei').toString();

const gasPrices: ChainMap<GasPriceConfig> = {
  test1: {
    amount: TEST_GAS_PRICE,
    decimals: 1,
  },
  test2: {
    amount: TEST_GAS_PRICE,
    decimals: 1,
  },
  test3: {
    amount: TEST_GAS_PRICE,
    decimals: 1,
  },
};

function getTokenExchangeRate(
  _local: ChainName,
  _remote: ChainName,
): BigNumber {
  return TEST_TOKEN_EXCHANGE_RATE;
}

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(chainNames, gasPrices, getTokenExchangeRate);
