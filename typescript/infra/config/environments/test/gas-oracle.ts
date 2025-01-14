import { BigNumber as BigNumberJs } from 'bignumber.js';

import { ChainMap, GasPriceConfig } from '@hyperlane-xyz/sdk';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
} from '../../../src/config/gas-oracle.js';

import { testChainNames } from './chains.js';

const TEST_TOKEN_EXCHANGE_RATE = new BigNumberJs('1');
const TEST_GAS_PRICE_CONFIG: GasPriceConfig = {
  amount: '2',
  decimals: 9, // gwei
};

const gasPrices: ChainMap<GasPriceConfig> = {
  test1: TEST_GAS_PRICE_CONFIG,
  test2: TEST_GAS_PRICE_CONFIG,
  test3: TEST_GAS_PRICE_CONFIG,
};

export const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    testChainNames,
    gasPrices,
    (_local, _remote) => TEST_TOKEN_EXCHANGE_RATE,
  );
