import { ethers } from 'ethers';
import { z } from 'zod';

import { routerConfigSchema } from '../router/schemas.js';

import { TokenType } from './config.js';

/// @notice This is a recreation of the ethersjs type, BigNumberish
/// @dev consider moving this to a higher place if other schemas depend on this
export const bigNumberIshSchema = z.union([
  z.instanceof(ethers.BigNumber),
  z.array(z.number()), // Bytes
  z.bigint(),
  z.string(),
  z.number(),
]);

export const tokenMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  totalSupply: bigNumberIshSchema,
});

export const tokenDecimalsSchema = z.object({
  decimals: z.number(),
  scale: z.number().optional(),
});

export const eRC20MetadataSchema = tokenMetadataSchema
  .merge(tokenDecimalsSchema)
  .partial();

export const eRC721MetadataSchema = z.object({
  isNft: z.boolean().optional(),
});

export const collateralConfigSchema = eRC721MetadataSchema
  .merge(eRC20MetadataSchema)
  .merge(
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

export const nativeConfigSchema = tokenDecimalsSchema.partial().merge(
  z.object({
    type: z.enum([TokenType.native]),
  }),
);

export const syntheticConfigSchema = tokenMetadataSchema.partial().merge(
  z.object({
    type: z.enum([
      TokenType.synthetic,
      TokenType.syntheticUri,
      TokenType.fastSynthetic,
    ]),
  }),
);

/// @dev discriminatedUnion is basically a switch statement for zod schemas
/// It uses the 'type' key to pick from the array of schemas to validate
export const tokenConfigSchema = z.discriminatedUnion('type', [
  nativeConfigSchema,
  collateralConfigSchema,
  syntheticConfigSchema,
]);

// TODO capitalize-case all the schema names
export const tokenRouterConfigSchema = z.intersection(
  tokenConfigSchema,
  routerConfigSchema,
);

export const WarpRouteDeployConfigSchema = z.record(
  z.string(),
  tokenRouterConfigSchema,
);
