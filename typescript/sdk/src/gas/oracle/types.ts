import { ethers } from 'ethers';

import { StorageGasOracle } from '@hyperlane-xyz/core';

import { TOKEN_EXCHANGE_RATE_EXPONENT } from '../../consts/igp.js';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

// Gas data to configure on a single destination chain.
export type StorageGasOracleConfig = Pick<
  StorageGasOracle.RemoteGasDataConfigStructOutput,
  'gasPrice' | 'tokenExchangeRate'
>;

export const formatGasOracleConfig = (
  config: StorageGasOracleConfig,
): {
  tokenExchangeRate: string;
  gasPrice: string;
} => ({
  tokenExchangeRate: ethers.utils.formatUnits(
    config.tokenExchangeRate,
    TOKEN_EXCHANGE_RATE_EXPONENT,
  ),
  gasPrice: ethers.utils.formatUnits(config.gasPrice, 'gwei'),
});

const percentDifference = (
  actual: ethers.BigNumber,
  expected: ethers.BigNumber,
): ethers.BigNumber => expected.sub(actual).mul(100).div(actual);

const serializePercentDifference = (
  actual: ethers.BigNumber,
  expected: ethers.BigNumber,
): string => {
  if (actual.isZero()) {
    return 'new';
  }
  const diff = percentDifference(actual, expected);
  return diff.isNegative() ? `${diff.toString()}%` : `+${diff.toString()}%`;
};

export const serializeDifference = (
  actual: StorageGasOracleConfig,
  expected: StorageGasOracleConfig,
): string => {
  const gasPriceDiff = serializePercentDifference(
    actual.gasPrice,
    expected.gasPrice,
  );
  const tokenExchangeRateDiff = serializePercentDifference(
    actual.tokenExchangeRate,
    expected.tokenExchangeRate,
  );
  const formatted = formatGasOracleConfig(expected);
  return `${formatted.tokenExchangeRate} (${tokenExchangeRateDiff}), ${formatted.gasPrice} gwei (${gasPriceDiff})`;
};
