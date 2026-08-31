import { z } from 'zod';

import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from '@hyperlane-xyz/provider-sdk/warp';

import {
  ZBigNumberish,
  ZBps,
  ZChainName,
  ZHash,
} from '../metadata/customZodTypes.js';

import {
  MAX_BPS_DECIMALS,
  convertToBps,
  isBpsPrecisionValid,
} from './utils.js';

// Matches the enum in BaseFee.sol
export enum OnchainTokenFeeType {
  LinearFee = 1,
  RegressiveFee = 2,
  ProgressiveFee = 3,
  RoutingFee = 4,
  CrossCollateralRoutingFee = 5,
  OffchainQuotedLinearFee = 6,
}

export const TokenFeeType = {
  LinearFee: 'LinearFee',
  ProgressiveFee: 'ProgressiveFee',
  RegressiveFee: 'RegressiveFee',
  RoutingFee: 'RoutingFee',
  CrossCollateralRoutingFee: 'CrossCollateralRoutingFee',
  OffchainQuotedLinearFee: 'OffchainQuotedLinearFee',
} as const;

export type TokenFeeType = (typeof TokenFeeType)[keyof typeof TokenFeeType];

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

// keccak256("RoutingFee.DEFAULT_ROUTER") — same wildcard slot as provider-sdk's
// DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY; re-exported here to avoid duplication.
export const DEFAULT_ROUTER_KEY = DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY;

// ====== SHARED SCHEMAS ======

// For deployed/read configs - token is required for BaseFee implementations
export const BaseFeeConfigSchema = z.object({
  token: ZHash,
  owner: ZHash,
});
export type BaseTokenFeeConfig = z.infer<typeof BaseFeeConfigSchema>;

// For input configs - token is NOT specified by user, resolved at deploy time based on token type
export const BaseFeeConfigInputSchema = z.object({
  owner: ZHash.optional(),
  beneficiary: ZHash.optional(),
});

export const FeeParametersSchema = z.object({
  maxFee: ZBigNumberish,
  halfAmount: ZBigNumberish,
});
export type FeeParameters = z.infer<typeof FeeParametersSchema>;

const StandardFeeConfigBaseSchema = BaseFeeConfigSchema.extend(
  FeeParametersSchema.shape,
);

const BpsConfigSchema = StandardFeeConfigBaseSchema.extend({
  bps: ZBps,
});

// Shared schema for offchain quote signer configuration
export const QuoteSignersSchema = z.object({
  quoteSigners: z.array(ZHash).optional(),
});
export type QuoteSignersConfig = z.infer<typeof QuoteSignersSchema>;

// ====== INDIVIDUAL FEE SCHEMAS ======

export const LinearFeeConfigSchema = BpsConfigSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
});
export type LinearFeeConfig = z.infer<typeof LinearFeeConfigSchema>;

// Linear Fee Input - only requires bps & type, token is optional
export const LinearFeeInputConfigSchema = BaseFeeConfigInputSchema.extend({
  type: z.literal(TokenFeeType.LinearFee),
  bps: ZBps.optional(),
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

    if (hasBps && v.bps! <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['bps'],
        message: 'bps must be > 0',
      });
    }

    if (hasBps && !isBpsPrecisionValid(v.bps!)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bps'],
        message: `bps must have at most ${MAX_BPS_DECIMALS} decimal places`,
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

export const OffchainQuotedLinearFeeConfigSchema = BpsConfigSchema.extend({
  ...QuoteSignersSchema.shape,
  type: z.literal(TokenFeeType.OffchainQuotedLinearFee),
});
export type OffchainQuotedLinearFeeConfig = z.infer<
  typeof OffchainQuotedLinearFeeConfigSchema
>;

export const OffchainQuotedLinearFeeInputConfigSchema =
  BaseFeeConfigInputSchema.extend({
    ...QuoteSignersSchema.shape,
    type: z.literal(TokenFeeType.OffchainQuotedLinearFee),
    bps: ZBps.optional(),
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

      if (hasBps && v.bps! <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['bps'],
          message: 'bps must be > 0',
        });
      }

      if (hasBps && !isBpsPrecisionValid(v.bps!)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bps'],
          message: `bps must have at most ${MAX_BPS_DECIMALS} decimal places`,
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

// Zod 4's upgraded discriminated unions support refined and transformed
// members directly, so the non-recursive members no longer need a plain union.
export const LeafTokenFeeConfigSchema = z.discriminatedUnion('type', [
  LinearFeeConfigSchema,
  OffchainQuotedLinearFeeConfigSchema,
  ProgressiveFeeConfigSchema,
  RegressiveFeeConfigSchema,
]);
export type LeafTokenFeeConfig = z.infer<typeof LeafTokenFeeConfigSchema>;

export const LeafTokenFeeInputConfigSchema = z.discriminatedUnion('type', [
  LinearFeeInputConfigSchema,
  OffchainQuotedLinearFeeInputConfigSchema,
  ProgressiveFeeInputConfigSchema,
  RegressiveFeeInputConfigSchema,
]);
export type LeafTokenFeeInputConfig = z.infer<
  typeof LeafTokenFeeInputConfigSchema
>;

export interface RoutingFeeConfig extends BaseTokenFeeConfig {
  type: typeof TokenFeeType.RoutingFee;
  feeContracts: Record<string, TokenFeeConfig>;
}

export interface CrossCollateralRoutingFeeConfig {
  type: typeof TokenFeeType.CrossCollateralRoutingFee;
  owner: string;
  feeContracts: Record<string, Record<string, TokenFeeConfig>>;
}

export interface StandardTokenFeeConfig
  extends BaseTokenFeeConfig, FeeParameters {
  type: (typeof ImmutableTokenFeeType)[number];
  bps?: number;
}

export type TokenFeeConfig =
  | StandardTokenFeeConfig
  | OffchainQuotedLinearFeeConfig
  | RoutingFeeConfig
  | CrossCollateralRoutingFeeConfig;

type BaseTokenFeeInputConfig = z.infer<typeof BaseFeeConfigInputSchema>;

export interface RoutingFeeInputConfig extends BaseTokenFeeInputConfig {
  type: typeof TokenFeeType.RoutingFee;
  feeContracts: Record<string, TokenFeeConfigInput>;
}

export interface CrossCollateralRoutingFeeInputConfig extends BaseTokenFeeInputConfig {
  type: typeof TokenFeeType.CrossCollateralRoutingFee;
  feeContracts: Record<string, Record<string, TokenFeeConfigInput>>;
}

export interface StandardTokenFeeInputConfig extends BaseTokenFeeInputConfig {
  type: (typeof ImmutableTokenFeeType)[number];
  bps?: number;
  maxFee?: bigint;
  halfAmount?: bigint;
}

export type TokenFeeConfigInput =
  | StandardTokenFeeInputConfig
  | OffchainQuotedLinearFeeInputConfig
  | RoutingFeeInputConfig
  | CrossCollateralRoutingFeeInputConfig;

export const RoutingFeeConfigSchema: z.ZodType<RoutingFeeConfig> =
  BaseFeeConfigSchema.extend({
    type: z.literal(TokenFeeType.RoutingFee),
    feeContracts: z.record(
      ZChainName,
      z.lazy((): z.ZodType<TokenFeeConfig> => TokenFeeConfigSchema),
    ),
  });

const CROSS_COLLATERAL_DESTINATION_MESSAGE =
  'CrossCollateralRoutingFee destinations must define at least one router fee';

const CrossCollateralRoutingFeeDestinationConfigSchema: z.ZodType<
  Record<string, TokenFeeConfig>
> = z
  .record(
    ZHash,
    z.lazy((): z.ZodType<TokenFeeConfig> => TokenFeeConfigSchema),
  )
  .refine((value) => Object.keys(value).length > 0, {
    error: CROSS_COLLATERAL_DESTINATION_MESSAGE,
  });

export const CrossCollateralRoutingFeeConfigSchema: z.ZodType<CrossCollateralRoutingFeeConfig> =
  z.object({
    type: z.literal(TokenFeeType.CrossCollateralRoutingFee),
    owner: ZHash,
    feeContracts: z.record(
      ZChainName,
      CrossCollateralRoutingFeeDestinationConfigSchema,
    ), // Destination -> { routerKey -> Fee }, including DEFAULT_ROUTER_KEY
  });

// Routing Fee Input - maxFee/halfAmount NOT configurable (contract hardcodes to max uint256)
export const RoutingFeeInputConfigSchema: z.ZodType<RoutingFeeInputConfig> =
  BaseFeeConfigInputSchema.extend({
    type: z.literal(TokenFeeType.RoutingFee),
    feeContracts: z.record(
      ZChainName,
      z.lazy((): z.ZodType<TokenFeeConfigInput> => TokenFeeConfigInputSchema),
    ),
  }).refine((value) => Object.keys(value.feeContracts).length > 0, {
    path: ['feeContracts'],
    message: 'RoutingFee must define at least one destination fee',
  });

const CrossCollateralRoutingFeeDestinationInputConfigSchema: z.ZodType<
  Record<string, TokenFeeConfigInput>
> = z
  .record(
    ZHash,
    z.lazy((): z.ZodType<TokenFeeConfigInput> => TokenFeeConfigInputSchema),
  )
  .refine((value) => Object.keys(value).length > 0, {
    error: CROSS_COLLATERAL_DESTINATION_MESSAGE,
  });

export const CrossCollateralRoutingFeeInputConfigSchema: z.ZodType<CrossCollateralRoutingFeeInputConfig> =
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

// ====== UNION SCHEMAS ======

export const TokenFeeConfigSchema: z.ZodType<TokenFeeConfig> = z.union([
  LeafTokenFeeConfigSchema,
  RoutingFeeConfigSchema,
  CrossCollateralRoutingFeeConfigSchema,
]);

export const TokenFeeConfigInputSchema: z.ZodType<TokenFeeConfigInput> =
  z.union([
    LeafTokenFeeInputConfigSchema,
    RoutingFeeInputConfigSchema,
    CrossCollateralRoutingFeeInputConfigSchema,
  ]);

export type ResolvedLinearFeeConfigInput = LinearFeeInputConfig & {
  owner: string;
  token: string;
};
export type ResolvedProgressiveFeeConfigInput = ProgressiveFeeInputConfig & {
  owner: string;
  token: string;
};
export type ResolvedRegressiveFeeConfigInput = RegressiveFeeInputConfig & {
  owner: string;
  token: string;
};

// Resolved routing fee config with nested resolved fee contracts
export type ResolvedRoutingFeeConfigInput = RoutingFeeInputConfig & {
  owner: string;
  token: string;
  feeContracts: Record<string, ResolvedTokenFeeConfigInput>;
};

export type ResolvedCrossCollateralRoutingFeeConfigInput =
  CrossCollateralRoutingFeeInputConfig & {
    owner: string;
    feeContracts: Record<string, Record<string, ResolvedTokenFeeConfigInput>>;
  };

export type ResolvedOffchainQuotedLinearFeeConfigInput =
  OffchainQuotedLinearFeeInputConfig & {
    owner: string;
    token: string;
  };

export type ResolvedStandardTokenFeeConfigInput =
  StandardTokenFeeInputConfig & {
    owner: string;
    token: string;
  };

export type ResolvedTokenFeeConfigInput =
  | ResolvedStandardTokenFeeConfigInput
  | ResolvedOffchainQuotedLinearFeeConfigInput
  | ResolvedRoutingFeeConfigInput
  | ResolvedCrossCollateralRoutingFeeConfigInput;
