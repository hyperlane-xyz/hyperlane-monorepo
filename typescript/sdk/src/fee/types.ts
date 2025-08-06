import { z } from 'zod';

import { ZChainName } from '../metadata/customZodTypes.js';

export enum TokenFeeType {
  LinearFee = 'LinearFee',
  ProgressiveFee = 'ProgressiveFee',
  RegressiveFee = 'RegressiveFee',
  RoutingFee = 'RoutingFee',
}

const BaseFeeSchema = z.object({
  token: z.string(),
  owner: z.string(),
  maxFee: z.string().default('0'),
  halfAmount: z.string().default('0'),
  bps: z.number().default(0),
});

export type BaseTokenFeeConfig = z.infer<typeof BaseFeeSchema>;

const LinearFeeSchema = z.object({
  type: z.literal(TokenFeeType.LinearFee),
  ...BaseFeeSchema.shape,
});

const ProgressiveFeeSchema = z.object({
  type: z.literal(TokenFeeType.ProgressiveFee),
  ...BaseFeeSchema.shape,
});

const RegressiveFeeSchema = z.object({
  type: z.literal(TokenFeeType.RegressiveFee),
  ...BaseFeeSchema.shape,
});

const RoutingFeeSchema = z.object({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z.record(ZChainName, BaseFeeSchema), // Destination -> Fee
  ...BaseFeeSchema.shape,
});

export const TokenFeeSchema = z.discriminatedUnion('type', [
  LinearFeeSchema,
  ProgressiveFeeSchema,
  RegressiveFeeSchema,
  RoutingFeeSchema,
]);

export type TokenFee = z.infer<typeof TokenFeeSchema>;
