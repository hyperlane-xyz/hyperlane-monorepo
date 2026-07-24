import { z } from 'zod';

import { isValidAddressSealevel } from '@hyperlane-xyz/utils';

import { ZChainName } from '../metadata/customZodTypes.js';
import type { TypedTransaction } from '../providers/ProviderType.js';
import { TokenConfigSchema } from '../token/IToken.js';
import type { TokenAmount } from '../token/TokenAmount.js';
import type { ChainName } from '../types.js';

const ZSealevelAddress = z.string().refine(isValidAddressSealevel, {
  message: 'Must be a valid Sealevel address (base58-encoded 32-byte pubkey)',
});

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
      sealevel: z
        .object({
          altAddresses: z
            .record(
              ZChainName,
              z.object({
                core: ZSealevelAddress,
                warpSpecific: z.array(ZSealevelAddress).min(1),
              }),
            )
            .optional()
            .describe(
              'Sealevel Address Lookup Table addresses per chain. `core` is the chain-shared ALT; `warpSpecific` lists the warp-route-specific ALTs.',
            ),
        })
        .optional()
        .describe('Sealevel-specific options for this warp route.'),
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
  tokenFeeQuote?: TokenAmount;
}
