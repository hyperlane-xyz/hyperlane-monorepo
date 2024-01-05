import { BigNumber, ethers } from 'ethers';

import { StorageGasOraclesConfig } from '../../gas/oracle/types';
import { ChainMap, ChainName } from '../../types';
import {
  TOKEN_EXCHANGE_RATE_DECIMALS,
  getAllStorageGasOracleConfigs,
} from '../gasOracle';

import { testChainNames } from './chains';

const TEST_TOKEN_EXCHANGE_RATE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);
const TEST_GAS_PRICE = ethers.utils.parseUnits('2', 'gwei');

const gasPrices: ChainMap<BigNumber> = {
  test1: TEST_GAS_PRICE,
  test2: TEST_GAS_PRICE,
  test3: TEST_GAS_PRICE,
};

function getTokenExchangeRate(
  _local: ChainName,
  _remote: ChainName,
): BigNumber {
  return TEST_TOKEN_EXCHANGE_RATE;
}

export const storageGasOraclesConfig: ChainMap<StorageGasOraclesConfig> =
  getAllStorageGasOracleConfigs(
    testChainNames,
    gasPrices,
    getTokenExchangeRate,
  );
