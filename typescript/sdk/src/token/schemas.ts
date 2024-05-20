import { z } from 'zod';

import { GasRouterConfigSchema } from '../router/schemas.js';

import { TokenType } from './config.js';

export const TokenMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  totalSupply: z.string().or(z.number()),
  decimals: z.number().optional(),
  scale: z.number().optional(),
  isNft: z.boolean().optional(),
});

export const CollateralConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([
    TokenType.collateral,
    TokenType.collateralXERC20,
    TokenType.collateralFiat,
    TokenType.collateralUri,
    TokenType.fastCollateral,
    TokenType.collateralVault,
  ]),
  token: z.string(),
});

export const NativeConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([TokenType.native, TokenType.nativeScaled]),
});

export const SyntheticConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([
    TokenType.synthetic,
    TokenType.syntheticUri,
    TokenType.fastSynthetic,
  ]),
});

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

export const TokenRouterConfigSchema = TokenConfigSchema.and(
  GasRouterConfigSchema,
);

export const WarpRouteDeployConfigSchema = z
  .record(TokenRouterConfigSchema)
  .refine((configMap) => {
    const entries = Object.entries(configMap);
    return (
      entries.some(
        ([_, config]) =>
          CollateralConfigSchema.safeParse(config).success ||
          NativeConfigSchema.safeParse(config).success,
      ) ||
      entries.filter(
        ([_, config]) => TokenMetadataSchema.safeParse(config).success,
      ).length === entries.length
    );
  }, `Config must include Native or Collateral OR all synthetics must define token metadata`);
