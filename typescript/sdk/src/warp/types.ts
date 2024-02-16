import { z } from 'zod';

import { ZChainName, ZUint } from '../metadata/customZodTypes';
import { TokenStandard } from '../token/TokenStandard';
import { ChainName } from '../types';

// Map of protocol to either quote constant or to a map of chain name to quote constant
export type IgpQuoteConstants = Array<{
  origin: ChainName;
  destination: ChainName;
  quote: string | number | bigint;
}>;

export type RouteBlacklist = Array<{
  origin: ChainName;
  destination: ChainName;
}>;

/**
 * Configuration used for instantiating a WarpCore
 * Contains the relevant tokens and their connections
 */
export const WarpCoreTokenConfigSchema = z.object({
  chainName: ZChainName.describe(
    'The name of the chain, must correspond to a chain in the multiProvider chainMetadata',
  ),
  standard: z
    .nativeEnum(TokenStandard)
    .describe('The type of token. See TokenStandard for valid values.'),
  decimals: ZUint.lt(256).describe('The decimals value (e.g. 18 for Eth)'),
  symbol: z.string().min(1).describe('The symbol of the token'),
  name: z.string().min(1).describe('The name of the token'),
  addressOrDenom: z
    .string()
    .min(1)
    .or(z.null())
    .describe('The address or denom, or null for native tokens'),
  connectedTokens: z
    .array(z.string().regex(/^(.+)|(.+)|(.+)$/))
    .describe('The connected warp tokens'),
});

export const WarpCoreConfigSchema = z.object({
  tokens: z.array(WarpCoreTokenConfigSchema),
  options: z.object({
    igpQuoteConstants: z
      .array(
        z.object({
          origin: ZChainName,
          destination: ZChainName,
          quote: z.union([z.string(), z.number(), z.bigint()]),
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
  }),
});

export type WarpCoreConfig = z.infer<typeof WarpCoreConfigSchema>;
