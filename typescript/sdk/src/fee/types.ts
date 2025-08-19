import { z } from 'zod';

import {
  ZBigNumberish,
  ZChainName,
  ZHash,
} from '../metadata/customZodTypes.js';

// Matches the enum in BaseFee.sol
export enum OnchainTokenFeeType {
  LinearFee = 1,
  RegressiveFee = 2,
  ProgressiveFee = 3,
  RoutingFee = 4,
}

export enum TokenFeeType {
  LinearFee = 'LinearFee',
  ProgressiveFee = 'ProgressiveFee',
  RegressiveFee = 'RegressiveFee',
  RoutingFee = 'RoutingFee',
}

// Mapping between the on-chain token fee type (uint) and the token fee type (string)
export const onChainTypeToTokenFeeTypeMap: Record<
  OnchainTokenFeeType,
  TokenFeeType
> = {
  [OnchainTokenFeeType.LinearFee]: TokenFeeType.LinearFee,
  [OnchainTokenFeeType.RegressiveFee]: TokenFeeType.RegressiveFee,
  [OnchainTokenFeeType.ProgressiveFee]: TokenFeeType.ProgressiveFee,
  [OnchainTokenFeeType.RoutingFee]: TokenFeeType.RoutingFee,
};

export const BaseFeeConfigSchema = z.object({
  token: ZHash,
  owner: ZHash,
  maxFee: ZBigNumberish.transform(BigInt),
  halfAmount: ZBigNumberish.transform(BigInt),
});
export type BaseTokenFeeConfig = z.infer<typeof BaseFeeConfigSchema>;

export const LinearFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.LinearFee),
  ...BaseFeeConfigSchema.shape,
  bps: ZBigNumberish,
});
export type LinearFeeConfig = z.infer<typeof LinearFeeConfigSchema>;

export const LinearFeeInputConfigSchema = z.object({
  ...LinearFeeConfigSchema.shape,
  maxFee: ZBigNumberish.optional(),
  halfAmount: ZBigNumberish.optional(),
  bps: ZBigNumberish.optional(),
});
export type LinearFeeInputConfig = z.infer<typeof LinearFeeInputConfigSchema>;

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

export const RoutingFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z
    .record(
      ZChainName,
      z.lazy((): z.ZodSchema => TokenFeeConfigSchema),
    )
    .optional(), // Destination -> Fee
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

export const TokenFeeConfigInputSchema = z.discriminatedUnion('type', [
  LinearFeeInputConfigSchema,
  ProgressiveFeeConfigSchema,
  RegressiveFeeConfigSchema,
  RoutingFeeConfigSchema,
]);
export type TokenFeeConfigInput = z.infer<typeof TokenFeeConfigInputSchema>;
