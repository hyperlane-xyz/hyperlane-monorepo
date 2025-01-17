import { ChainMap, GasPriceConfig } from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config/gas-oracle.js';

import { testChainNames } from './chains.js';

const TEST_TOKEN_EXCHANGE_RATE = '1';
const TEST_GAS_PRICE_CONFIG: GasPriceConfig = {
  amount: '2',
  decimals: 9, // gwei
};

const tokenPrices: ChainMap<string> = {
  test1: TEST_TOKEN_EXCHANGE_RATE,
  test2: TEST_TOKEN_EXCHANGE_RATE,
  test3: TEST_TOKEN_EXCHANGE_RATE,
};

const gasPrices: ChainMap<GasPriceConfig> = {
  test1: TEST_GAS_PRICE_CONFIG,
  test2: TEST_GAS_PRICE_CONFIG,
  test3: TEST_GAS_PRICE_CONFIG,
};

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    testChainNames,
    tokenPrices,
    gasPrices,
    (_local, _remote) => 0,
    false,
  );
