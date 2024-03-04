import { z } from 'zod';

import { ZChainName } from '../metadata/customZodTypes';
import { TypedTransaction } from '../providers/ProviderType';
import { TokenConfigSchema } from '../token/IToken';
import { ChainName } from '../types';

// Map of protocol to either quote constant or to a map of chain name to quote constant
export type IgpQuoteConstants = Array<{
  origin: ChainName;
  destination: ChainName;
  amount: string | number | bigint;
  addressOrDenom?: string;
}>;

// List of chain pairs to blacklist for warp routes
export type RouteBlacklist = Array<{
  origin: ChainName;
  destination: ChainName;
}>;

// Transaction types for warp core remote transfers
export enum WarpTxCategory {
  Approval = 'approval',
  Transfer = 'transfer',
}

export type WarpTypedTransaction = TypedTransaction & {
  category: WarpTxCategory;
};

/**
 * Configuration used for instantiating a WarpCore
 * Contains the relevant tokens and their connections
 */
export const WarpCoreConfigSchema = z.object({
  tokens: z.array(TokenConfigSchema),
  options: z
    .object({
      igpQuoteConstants: z
        .array(
          z.object({
            origin: ZChainName,
            destination: ZChainName,
            amount: z.union([z.string(), z.number(), z.bigint()]),
            addressOrDenom: z.string().optional(),
          }),
        )
        .optional(),
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

export type WarpCoreConfig = z.infer<typeof WarpCoreConfigSchema>;
