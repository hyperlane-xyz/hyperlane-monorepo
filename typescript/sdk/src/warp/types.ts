import { z } from 'zod';

import { ZChainName } from '../metadata/customZodTypes.js';
import type { TypedTransaction } from '../providers/ProviderType.js';
import { TokenConfigSchema } from '../token/IToken.js';
import type { TokenAmount } from '../token/TokenAmount.js';
import type { ChainName } from '../types.js';

/**
 * Configuration used for instantiating a WarpCore
 * Contains the relevant tokens and their connections
 */
const FeeConstantConfigSchema = z.array(
  z.object({
    origin: ZChainName,
    destination: ZChainName,
    amount: z.union([z.string(), z.number(), z.bigint()]),
    addressOrDenom: z.string().optional(),
  }),
);

export const WarpCoreConfigSchema = z.object({
  tokens: z.array(TokenConfigSchema),
  options: z
    .object({
      localFeeConstants: FeeConstantConfigSchema.optional(),
      interchainFeeConstants: FeeConstantConfigSchema.optional(),
      routeBlacklist: z
        .array(
          z.object({
            origin: ZChainName,
            destination: ZChainName,
          }),
        )
        .optional(),
    })
    .optional(),
});

// List of constant values for local or interchain fees
export type FeeConstantConfig = z.infer<typeof FeeConstantConfigSchema>;

// List of chain pairs to blacklist for warp routes
export type RouteBlacklist = Array<{
  origin: ChainName;
  destination: ChainName;
}>;

// Transaction types for warp core remote transfers
export enum WarpTxCategory {
  Approval = 'approval',
  Revoke = 'revoke',
  Transfer = 'transfer',
}

export type WarpTypedTransaction = TypedTransaction & {
  category: WarpTxCategory;
};

export type WarpCoreConfig = z.infer<typeof WarpCoreConfigSchema>;

export interface WarpCoreFeeEstimate {
  interchainQuote: TokenAmount;
  localQuote: TokenAmount;
}
