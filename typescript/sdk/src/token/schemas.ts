import { z } from 'zod';

import { routerConfigSchema } from '../router/schemas.js';

import { TokenType } from './config.js';

export const TokenMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  totalSupply: z.string().or(z.number()),
});

export const TokenDecimalsSchema = z.object({
  decimals: z.number(),
  scale: z.number().optional(),
});

export const ERC20MetadataSchema =
  TokenMetadataSchema.merge(TokenDecimalsSchema).partial();

export const ERC721MetadataSchema = z.object({
  isNft: z.boolean().optional(),
});

export const CollateralConfigSchema = ERC721MetadataSchema.merge(
  ERC20MetadataSchema,
).merge(
  z.object({
    type: z.enum([
      TokenType.collateral,
      TokenType.collateralUri,
      TokenType.fastCollateral,
      TokenType.collateralVault,
    ]),
    token: z.string(),
  }),
);

export const NativeConfigSchema = TokenDecimalsSchema.partial().merge(
  z.object({
    type: z.enum([TokenType.native]),
  }),
);

export const SyntheticConfigSchema = TokenMetadataSchema.partial().merge(
  z.object({
    type: z.enum([
      TokenType.synthetic,
      TokenType.syntheticUri,
      TokenType.fastSynthetic,
    ]),
  }),
);

/**
 * @remarks
 * The discriminatedUnion is basically a switch statement for zod schemas
 * It uses the 'type' key to pick from the array of schemas to validate
 */
export const TokenConfigSchema = z.discriminatedUnion('type', [
  NativeConfigSchema,
  CollateralConfigSchema,
  SyntheticConfigSchema,
]);

export const TokenRouterConfigSchema = z.intersection(
  TokenConfigSchema,
  routerConfigSchema,
);

export const WarpRouteDeployConfigSchema = z.record(
  z.string(),
  TokenRouterConfigSchema,
);
