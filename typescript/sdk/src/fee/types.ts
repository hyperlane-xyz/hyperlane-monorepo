import { z } from 'zod';

import {
  ZBigNumberish,
  ZChainName,
  ZHash,
} from '../metadata/customZodTypes.js';

import { convertToBps } from './utils.js';

// Matches the enum in BaseFee.sol
export enum OnchainTokenFeeType {
  LinearFee = 1,
  RegressiveFee = 2,
  ProgressiveFee = 3,
  RoutingFee = 4,
  CrossCollateralRoutingFee = 5,
  OffchainQuotedLinearFee = 6,
}

export enum TokenFeeType {
  LinearFee = 'LinearFee',
  ProgressiveFee = 'ProgressiveFee',
  RegressiveFee = 'RegressiveFee',
  RoutingFee = 'RoutingFee',
  CrossCollateralRoutingFee = 'CrossCollateralRoutingFee',
  OffchainQuotedLinearFee = 'OffchainQuotedLinearFee',
}

export const ImmutableTokenFeeType = [
  TokenFeeType.LinearFee,
  TokenFeeType.RegressiveFee,
  TokenFeeType.ProgressiveFee,
] as const;

// Mapping between the on-chain token fee type (uint) and the token fee type (string)
export const onChainTypeToTokenFeeTypeMap: Record<
  OnchainTokenFeeType,
  TokenFeeType
> = {
  [OnchainTokenFeeType.LinearFee]: TokenFeeType.LinearFee,
  [OnchainTokenFeeType.RegressiveFee]: TokenFeeType.RegressiveFee,
  [OnchainTokenFeeType.ProgressiveFee]: TokenFeeType.ProgressiveFee,
  [OnchainTokenFeeType.RoutingFee]: TokenFeeType.RoutingFee,
  [OnchainTokenFeeType.CrossCollateralRoutingFee]:
    TokenFeeType.CrossCollateralRoutingFee,
  [OnchainTokenFeeType.OffchainQuotedLinearFee]:
    TokenFeeType.OffchainQuotedLinearFee,
};

// keccak256("RoutingFee.DEFAULT_ROUTER")
export const DEFAULT_ROUTER_KEY =
  '0x6e086cd647d6eb8b516856666e2c1465fb8a6a58d3a75938362acc674eacaf47';

// ====== SHARED SCHEMAS ======

// For deployed/read configs - token is required for BaseFee implementations
export const BaseFeeConfigSchema = z.object({
  token: ZHash,
  owner: ZHash,
});
export type BaseTokenFeeConfig = z.infer<typeof BaseFeeConfigSchema>;

// For input configs - token is NOT specified by user, resolved at deploy time based on token type
export const BaseFeeConfigInputSchema = z.object({
  owner: ZHash,
});

export const FeeParametersSchema = z.object({
  maxFee: ZBigNumberish,
  halfAmount: ZBigNumberish,
});
export type FeeParameters = z.infer<typeof FeeParametersSchema>;

const StandardFeeConfigBaseSchema =
  BaseFeeConfigSchema.merge(FeeParametersSchema);

// Shared schema for offchain quote signer configuration
export const QuoteSignersSchema = z.object({
  quoteSigners: z.array(ZHash).optional(),
});
export type QuoteSignersConfig = z.infer<typeof QuoteSignersSchema>;

// ====== INDIVIDUAL FEE SCHEMAS ======

export const LinearFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
  bps: ZBigNumberish,
});
export type LinearFeeConfig = z.infer<typeof LinearFeeConfigSchema>;

// Linear Fee Input - only requires bps & type, token is optional
export const LinearFeeInputConfigSchema = BaseFeeConfigInputSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
  bps: ZBigNumberish.optional(),
  ...FeeParametersSchema.partial().shape,
})
  .superRefine((v, ctx) => {
    const hasBps = v.bps !== undefined;
    const hasFeeParams = v.maxFee !== undefined && v.halfAmount !== undefined;

    if (!hasBps && !hasFeeParams) {
      ctx.addIssue({
        code: 'custom',
        path: ['bps'],
        message: 'Provide bps or both maxFee and halfAmount',
      });
    }

    // Reject bps = 0 to prevent division by zero in convertFromBps
    if (hasBps && BigInt(v.bps!) === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['bps'],
        message: 'bps must be > 0',
      });
    }

    if (v.halfAmount === 0n) {
      // Prevents divide by 0
      ctx.addIssue({
        code: 'custom',
        path: ['halfAmount'],
        message: 'halfAmount must be > 0',
      });
    }
  })
  .transform((v) => ({
    ...v,
    bps: v.bps ?? convertToBps(v.maxFee!, v.halfAmount!),
  }));
export type LinearFeeInputConfig = z.infer<typeof LinearFeeInputConfigSchema>;

export const OffchainQuotedLinearFeeConfigSchema =
  StandardFeeConfigBaseSchema.merge(QuoteSignersSchema).extend({
    type: z.literal(TokenFeeType.OffchainQuotedLinearFee),
    bps: ZBigNumberish,
  });
export type OffchainQuotedLinearFeeConfig = z.infer<
  typeof OffchainQuotedLinearFeeConfigSchema
>;

export const OffchainQuotedLinearFeeInputConfigSchema =
  BaseFeeConfigInputSchema.merge(QuoteSignersSchema)
    .extend({
      type: z.literal(TokenFeeType.OffchainQuotedLinearFee),
      bps: ZBigNumberish.optional(),
      ...FeeParametersSchema.partial().shape,
    })
    .superRefine((v, ctx) => {
      const hasBps = v.bps !== undefined;
      const hasFeeParams = v.maxFee !== undefined && v.halfAmount !== undefined;

      if (!hasBps && !hasFeeParams) {
        ctx.addIssue({
          code: 'custom',
          path: ['bps'],
          message: 'Provide bps or both maxFee and halfAmount',
        });
      }

      if (hasBps && BigInt(v.bps!) === 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['bps'],
          message: 'bps must be > 0',
        });
      }

      if (v.halfAmount === 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['halfAmount'],
          message: 'halfAmount must be > 0',
        });
      }
    })
    .transform((v) => ({
      ...v,
      bps: v.bps ?? convertToBps(v.maxFee!, v.halfAmount!),
    }));
export type OffchainQuotedLinearFeeInputConfig = z.infer<
  typeof OffchainQuotedLinearFeeInputConfigSchema
>;

export const ProgressiveFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.ProgressiveFee),
});
export type ProgressiveFeeConfig = z.infer<typeof ProgressiveFeeConfigSchema>;

export const ProgressiveFeeInputConfigSchema = BaseFeeConfigInputSchema.extend({
  type: z.literal(TokenFeeType.ProgressiveFee),
  maxFee: ZBigNumberish,
  halfAmount: ZBigNumberish,
}).refine((v) => BigInt(v.halfAmount) > 0n, {
  path: ['halfAmount'],
  message: 'halfAmount must be > 0',
});
export type ProgressiveFeeInputConfig = z.infer<
  typeof ProgressiveFeeInputConfigSchema
>;

export const RegressiveFeeConfigSchema = StandardFeeConfigBaseSchema.extend({
  type: z.literal(TokenFeeType.RegressiveFee),
});
export type RegressiveFeeConfig = z.infer<typeof RegressiveFeeConfigSchema>;

export const RegressiveFeeInputConfigSchema = BaseFeeConfigInputSchema.extend({
  type: z.literal(TokenFeeType.RegressiveFee),
  maxFee: ZBigNumberish,
  halfAmount: ZBigNumberish,
}).refine((v) => BigInt(v.halfAmount) > 0n, {
  path: ['halfAmount'],
  message: 'halfAmount must be > 0',
});
export type RegressiveFeeInputConfig = z.infer<
  typeof RegressiveFeeInputConfigSchema
>;

export const RoutingFeeConfigSchema = BaseFeeConfigSchema.extend({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z.record(
    ZChainName,
    z.lazy((): z.ZodSchema => TokenFeeConfigSchema),
  ), // Destination -> Fee
});
export type RoutingFeeConfig = z.infer<typeof RoutingFeeConfigSchema>;

const CROSS_COLLATERAL_DESTINATION_MESSAGE =
  'CrossCollateralRoutingFee destinations must define at least one router fee';

const CrossCollateralRoutingFeeDestinationConfigSchema = z
  .record(
    ZHash,
    z.lazy((): z.ZodSchema => TokenFeeConfigSchema),
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: CROSS_COLLATERAL_DESTINATION_MESSAGE,
  });

export const CrossCollateralRoutingFeeConfigSchema = z.object({
  type: z.literal(TokenFeeType.CrossCollateralRoutingFee),
  owner: ZHash,
  feeContracts: z.record(
    ZChainName,
    CrossCollateralRoutingFeeDestinationConfigSchema,
  ), // Destination -> { routerKey -> Fee }, including DEFAULT_ROUTER_KEY
});
export type CrossCollateralRoutingFeeConfig = z.infer<
  typeof CrossCollateralRoutingFeeConfigSchema
>;

// Routing Fee Input - maxFee/halfAmount NOT configurable (contract hardcodes to max uint256)
export const RoutingFeeInputConfigSchema = BaseFeeConfigInputSchema.extend({
  type: z.literal(TokenFeeType.RoutingFee),
  feeContracts: z.record(
    ZChainName,
    z.lazy((): z.ZodSchema => TokenFeeConfigInputSchema),
  ),
}).refine((value) => Object.keys(value.feeContracts).length > 0, {
  path: ['feeContracts'],
  message: 'RoutingFee must define at least one destination fee',
});
export type RoutingFeeInputConfig = z.infer<typeof RoutingFeeInputConfigSchema>;

const CrossCollateralRoutingFeeDestinationInputConfigSchema = z
  .record(
    ZHash,
    z.lazy((): z.ZodSchema => TokenFeeConfigInputSchema),
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: CROSS_COLLATERAL_DESTINATION_MESSAGE,
  });

export const CrossCollateralRoutingFeeInputConfigSchema =
  BaseFeeConfigInputSchema.extend({
    type: z.literal(TokenFeeType.CrossCollateralRoutingFee),
    feeContracts: z.record(
      ZChainName,
      CrossCollateralRoutingFeeDestinationInputConfigSchema,
    ),
  }).refine((value) => Object.keys(value.feeContracts).length > 0, {
    path: ['feeContracts'],
    message:
      'CrossCollateralRoutingFee must define at least one destination fee',
  });
export type CrossCollateralRoutingFeeInputConfig = z.infer<
  typeof CrossCollateralRoutingFeeInputConfigSchema
>;

// ====== UNION SCHEMAS ======

export const TokenFeeConfigSchema = z.discriminatedUnion('type', [
  LinearFeeConfigSchema,
  OffchainQuotedLinearFeeConfigSchema,
  ProgressiveFeeConfigSchema,
  RegressiveFeeConfigSchema,
  RoutingFeeConfigSchema,
  CrossCollateralRoutingFeeConfigSchema,
]);
export type TokenFeeConfig = z.infer<typeof TokenFeeConfigSchema>;

export const TokenFeeConfigInputSchema = z.union([
  LinearFeeInputConfigSchema,
  OffchainQuotedLinearFeeInputConfigSchema,
  ProgressiveFeeInputConfigSchema,
  RegressiveFeeInputConfigSchema,
  RoutingFeeInputConfigSchema,
  CrossCollateralRoutingFeeInputConfigSchema,
]);
export type TokenFeeConfigInput = z.infer<typeof TokenFeeConfigInputSchema>;

export type ResolvedLinearFeeConfigInput = LinearFeeInputConfig & {
  token: string;
};
export type ResolvedProgressiveFeeConfigInput = ProgressiveFeeInputConfig & {
  token: string;
};
export type ResolvedRegressiveFeeConfigInput = RegressiveFeeInputConfig & {
  token: string;
};

// Resolved routing fee config with nested resolved fee contracts
export type ResolvedRoutingFeeConfigInput = RoutingFeeInputConfig & {
  token: string;
  feeContracts: Record<string, ResolvedTokenFeeConfigInput>;
};

export type ResolvedCrossCollateralRoutingFeeConfigInput =
  CrossCollateralRoutingFeeInputConfig & {
    feeContracts: Record<string, Record<string, ResolvedTokenFeeConfigInput>>;
  };

export type ResolvedOffchainQuotedLinearFeeConfigInput =
  OffchainQuotedLinearFeeInputConfig & {
    token: string;
  };

export type ResolvedTokenFeeConfigInput =
  | ResolvedLinearFeeConfigInput
  | ResolvedOffchainQuotedLinearFeeConfigInput
  | ResolvedProgressiveFeeConfigInput
  | ResolvedRegressiveFeeConfigInput
  | ResolvedRoutingFeeConfigInput
  | ResolvedCrossCollateralRoutingFeeConfigInput;
