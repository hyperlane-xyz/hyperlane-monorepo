import { ethers } from 'ethers';

import { AllStorageGasOracleConfigs, RemoteGasData } from '../../../src/config';

import { TestChains } from './chains';

const testGasData: RemoteGasData = {
  // 10 decimals of precision
  tokenExchangeRate: ethers.utils.parseUnits('1', 10),
  gasPrice: ethers.utils.parseUnits('2', 'gwei'),
};

export const storageGasOracleConfig: AllStorageGasOracleConfigs<TestChains> = {
  test1: {
    test2: testGasData,
    test3: testGasData,
  },
  test2: {
    test1: testGasData,
    test3: testGasData,
  },
  test3: {
    test1: testGasData,
    test2: testGasData,
  },
};
