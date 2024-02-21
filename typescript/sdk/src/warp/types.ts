import { z } from 'zod';

import { ZChainName, ZUint } from '../metadata/customZodTypes';
import { TypedTransaction } from '../providers/ProviderType';
import { TokenStandard } from '../token/TokenStandard';
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
  collateralAddressOrDenom: z
    .string()
    .min(1)
    .optional()
    .describe('The address or denom of the collateralized token'),
  igpTokenAddressOrDenom: z
    .string()
    .min(1)
    .optional()
    .describe('The address or denom of the token for IGP payments'),
  logoURI: z.string().optional().describe('The URI of the token logo'),
  sourcePort: z
    .string()
    .optional()
    .describe('IBC tokens only: the source port'),
  sourceChannel: z
    .string()
    .optional()
    .describe('IBC tokens only: the source channel'),
  connectedTokens: z
    .array(z.string().regex(/^(.+)|(.+)|(.+)$/))
    .optional()
    .describe('The connected warp tokens'),
});

export const WarpCoreConfigSchema = z.object({
  tokens: z.array(WarpCoreTokenConfigSchema),
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
