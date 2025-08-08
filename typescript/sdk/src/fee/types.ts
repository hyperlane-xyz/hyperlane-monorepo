import { z } from 'zod';

import { ZChainName, ZUWei } from '../metadata/customZodTypes.js';

export enum OnchainTokenFeeType {
  ZeroFee,
  LinearFee,
  RegressiveFee,
  ProgressiveFee,
  RoutingFee,
}

export enum TokenFeeType {
  LinearFee = 'LinearFee',
  ProgressiveFee = 'ProgressiveFee',
  RegressiveFee = 'RegressiveFee',
  RoutingFee = 'RoutingFee',
}

const BaseFeeConfigSchema = z.object({
  token: z.string(),
  owner: z.string(),
  maxFee: ZUWei.optional().describe('Max fee'),
  halfAmount: ZUWei.optional().describe('Half of the max fee'),
  bps: ZUWei.optional().describe(
    'Bps for the token. Gets converted to maxFee and halfAmount based on fee model.',
  ),
});

export type BaseTokenFeeConfig = z.infer<typeof BaseFeeConfigSchema>;

const LinearFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.LinearFee),
  ...BaseFeeConfigSchema.shape,
});

export type LinearFeeConfig = z.infer<typeof LinearFeeConfigSchema>;

const ProgressiveFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.ProgressiveFee),
  ...BaseFeeConfigSchema.shape,
});

export type ProgressiveFeeConfig = z.infer<typeof ProgressiveFeeConfigSchema>;

const RegressiveFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.RegressiveFee),
  ...BaseFeeConfigSchema.shape,
});

export type RegressiveFeeConfig = z.infer<typeof RegressiveFeeConfigSchema>;

const RoutingFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z.record(ZChainName, BaseFeeConfigSchema), // Destination -> Fee
  ...BaseFeeConfigSchema.shape,
});

export type RoutingFeeConfig = z.infer<typeof RoutingFeeConfigSchema>;

export const TokenFeeConfigSchema = z.discriminatedUnion('type', [
  LinearFeeConfigSchema,
  ProgressiveFeeConfigSchema,
  RegressiveFeeConfigSchema,
  RoutingFeeConfigSchema,
]);

export type TokenFeeConfig = z.infer<typeof TokenFeeConfigSchema>;
