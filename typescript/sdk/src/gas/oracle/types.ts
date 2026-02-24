import { formatUnits } from 'viem';
import { z } from 'zod';

import { ProtocolType, toBigInt } from '@hyperlane-xyz/utils';

import { getProtocolExchangeRateDecimals } from '../../consts/igp.js';

export const StorageGasOracleConfigSchema = z.object({
  gasPrice: z.string(),
  tokenExchangeRate: z.string(),
});

// Gas data to configure on a single destination chain.
export type StorageGasOracleConfig = z.output<
  typeof StorageGasOracleConfigSchema
>;

export const ProtocolAgnositicGasOracleConfigSchema =
  StorageGasOracleConfigSchema.extend({
    // The number of decimals of the remote native token.
    // Optional because it's not required by all protocol types.
    tokenDecimals: z.number().optional(),
  });

// Gas data to configure on a single destination chain.
export type ProtocolAgnositicGasOracleConfig = z.output<
  typeof ProtocolAgnositicGasOracleConfigSchema
>;

export const IgpCostDataSchema = z.object({
  handleGasAmount: z.number(),
  totalGasAmount: z.number(),
  totalUsdCost: z.number(),
});

export type IgpCostData = z.output<typeof IgpCostDataSchema>;

export const ProtocolAgnositicGasOracleConfigWithTypicalCostSchema =
  ProtocolAgnositicGasOracleConfigSchema.extend({
    typicalCost: IgpCostDataSchema.optional(),
  });

export type ProtocolAgnositicGasOracleConfigWithTypicalCost = z.output<
  typeof ProtocolAgnositicGasOracleConfigWithTypicalCostSchema
>;

export type OracleData = {
  tokenExchangeRate: bigint;
  gasPrice: bigint;
};

export const formatGasOracleConfig = (
  localChainProtocol: ProtocolType,
  config: OracleData,
): {
  tokenExchangeRate: string;
  gasPrice: string;
} => ({
  tokenExchangeRate: formatUnits(
    config.tokenExchangeRate,
    getProtocolExchangeRateDecimals(localChainProtocol),
  ),
  gasPrice: formatUnits(config.gasPrice, 9),
});

const percentDifference = (actual: bigint, expected: bigint): bigint =>
  ((expected - actual) * 100n) / actual;

const serializePercentDifference = (
  actual: bigint,
  expected: bigint,
): string => {
  if (actual === 0n) {
    return 'new';
  }
  const diff = percentDifference(actual, expected);
  return diff < 0n ? `${diff.toString()}%` : `+${diff.toString()}%`;
};

// TODO: replace once #3771 is fixed
export const oracleConfigToOracleData = (
  config: StorageGasOracleConfig,
): OracleData => ({
  gasPrice: BigInt(config.gasPrice),
  tokenExchangeRate: BigInt(config.tokenExchangeRate),
});

export const serializeDifference = (
  localChainProtocol: ProtocolType,
  actual: OracleData,
  expected: OracleData,
): string => {
  const actualRecord = actual as unknown as Record<string | number, unknown>;
  const expectedRecord = expected as unknown as Record<
    string | number,
    unknown
  >;
  const actualData: OracleData = {
    gasPrice: toBigInt(actualRecord.gasPrice ?? actualRecord[1] ?? 0n),
    tokenExchangeRate: toBigInt(
      actualRecord.tokenExchangeRate ?? actualRecord[0] ?? 0n,
    ),
  };
  const expectedData: OracleData = {
    gasPrice: toBigInt(expectedRecord.gasPrice ?? expectedRecord[1] ?? 0n),
    tokenExchangeRate: toBigInt(
      expectedRecord.tokenExchangeRate ?? expectedRecord[0] ?? 0n,
    ),
  };

  const gasPriceDiff = serializePercentDifference(
    actualData.gasPrice,
    expectedData.gasPrice,
  );
  const tokenExchangeRateDiff = serializePercentDifference(
    actualData.tokenExchangeRate,
    expectedData.tokenExchangeRate,
  );

  const productDiff = serializePercentDifference(
    actualData.tokenExchangeRate * actualData.gasPrice,
    expectedData.tokenExchangeRate * expectedData.gasPrice,
  );

  const formatted = formatGasOracleConfig(localChainProtocol, expectedData);
  return `Exchange rate: ${formatted.tokenExchangeRate} (${tokenExchangeRateDiff}), Gas price: ${formatted.gasPrice} gwei (${gasPriceDiff}), Product diff: ${productDiff}`;
};
