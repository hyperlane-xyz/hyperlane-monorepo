import { ethers } from 'ethers';
import { z } from 'zod';

import { TOKEN_EXCHANGE_RATE_DECIMALS } from '../../consts/igp.js';

const BigNumberString = z.string().transform(ethers.BigNumber.from);

export const StorageGasOracleConfigSchema = z.object({
  gasPrice: BigNumberString,
  tokenExchangeRate: BigNumberString,
});

// Gas data to configure on a single destination chain.
export type StorageGasOracleConfig = z.output<
  typeof StorageGasOracleConfigSchema
>;

export const formatGasOracleConfig = (
  config: StorageGasOracleConfig,
): {
  tokenExchangeRate: string;
  gasPrice: string;
} => ({
  tokenExchangeRate: ethers.utils.formatUnits(
    config.tokenExchangeRate,
    TOKEN_EXCHANGE_RATE_DECIMALS,
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

  const productDiff = serializePercentDifference(
    actual.tokenExchangeRate.mul(actual.gasPrice),
    expected.tokenExchangeRate.mul(expected.gasPrice),
  );

  const formatted = formatGasOracleConfig(expected);
  return `Exchange rate: ${formatted.tokenExchangeRate} (${tokenExchangeRateDiff}), Gas price: ${formatted.gasPrice} gwei (${gasPriceDiff}), Product diff: ${productDiff}`;
};
