import { ethers } from 'ethers';
import { z } from 'zod';

// import { objMap } from '@hyperlane-xyz/utils';
import { routerConfigSchema } from '../router/schemas.js';

import { TokenType, isCollateralConfig } from './config.js';

/// This is a recreation of the ethersjs type, BigNumberish
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
  .partial()
  .and(tokenDecimalsSchema.partial());

export const syntheticConfigSchema = tokenMetadataSchema.and(
  z.object({
    type: z.union([
      z.literal(TokenType.synthetic),
      z.literal(TokenType.syntheticUri),
      z.literal(TokenType.fastSynthetic),
    ]),
  }),
);

export const collateralConfigSchema = z
  .object({
    type: z.union([
      z.literal(TokenType.collateral),
      z.literal(TokenType.collateralUri),
      z.literal(TokenType.fastCollateral),
      z.literal(TokenType.fastSynthetic),
      z.literal(TokenType.collateralVault),
    ]),
    token: z.string(),
  })
  .and(eRC20MetadataSchema);

export const nativeConfigSchema = z
  .object({
    type: z.literal(TokenType.native),
  })
  .and(tokenDecimalsSchema.partial());

export const tokenConfigSchema = z.union([
  syntheticConfigSchema,
  collateralConfigSchema,
  nativeConfigSchema,
]);

export const WarpRouteDeployConfigSchema = z
  .record(z.string(), z.intersection(tokenConfigSchema, routerConfigSchema))
  .superRefine((warpRouteDeployConfigs, ctx) => {
    for (const [_, config] of Object.entries(warpRouteDeployConfigs)) {
      // For collateralVault Warp Routes, token will specify the vault address
      if (
        isCollateralConfig(config) &&
        config.token === ethers.constants.AddressZero
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Vault address is required when type is collateralVault',
          path: ['token'],
        });
    }
    return true;
  });
