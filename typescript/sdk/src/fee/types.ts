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

// ====== SHARED SCHEMAS ======

export const BaseFeeConfigSchema = z.object({
  token: ZHash,
  owner: ZHash,
});
export type BaseTokenFeeConfig = z.infer<typeof BaseFeeConfigSchema>;

export const FeeParametersSchema = z.object({
  maxFee: ZBigNumberish,
  halfAmount: ZBigNumberish,
});
export type FeeParameters = z.infer<typeof FeeParametersSchema>;

const StandardFeeConfigBaseSchema =
  BaseFeeConfigSchema.merge(FeeParametersSchema);

// ====== INDIVIDUAL FEE SCHEMAS ======

export const LinearFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
  bps: ZBigNumberish,
});
export type LinearFeeConfig = z.infer<typeof LinearFeeConfigSchema>;

// Linear Fee Input - only requires bps
export const LinearFeeInputConfigSchema = BaseFeeConfigSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
  bps: ZBigNumberish,
});
export type LinearFeeInputConfig = z.infer<typeof LinearFeeInputConfigSchema>;

export const ProgressiveFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.ProgressiveFee),
});
export type ProgressiveFeeConfig = z.infer<typeof ProgressiveFeeConfigSchema>;

export const RegressiveFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.RegressiveFee),
});
export type RegressiveFeeConfig = z.infer<typeof RegressiveFeeConfigSchema>;

export const RoutingFeeConfigSchema = BaseFeeConfigSchema.extend({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z
    .record(
      ZChainName,
      z.lazy((): z.ZodSchema => TokenFeeConfigSchema),
    )
    .optional(), // Destination -> Fee
  maxFee: ZBigNumberish.optional(),
  halfAmount: ZBigNumberish.optional(),
});
export type RoutingFeeConfig = z.infer<typeof RoutingFeeConfigSchema>;

// ====== UNION SCHEMAS ======

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
