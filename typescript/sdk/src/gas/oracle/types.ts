import { ethers } from 'ethers';

import { StorageGasOracle } from '@hyperlane-xyz/core';

import { TOKEN_EXCHANGE_RATE_EXPONENT } from '../../consts/igp';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

// Gas data to configure on a single destination chain.
export type StorageGasOracleConfig = Pick<
  StorageGasOracle.RemoteGasDataConfigStructOutput,
  'gasPrice' | 'tokenExchangeRate'
>;

export const formatGasOracleConfig = (config: StorageGasOracleConfig): string =>
  `$ ${ethers.utils.formatUnits(
    config.tokenExchangeRate,
    TOKEN_EXCHANGE_RATE_EXPONENT,
  )}, ${ethers.utils.formatUnits(config.gasPrice, 'gwei')} gwei`;
