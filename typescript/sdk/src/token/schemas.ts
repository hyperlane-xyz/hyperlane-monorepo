import { z } from 'zod';

import { objMap } from '@hyperlane-xyz/utils';

import { GasRouterConfigSchema } from '../router/schemas.js';
import { isCompliant } from '../utils/schemas.js';

import { TokenType } from './config.js';

export const WarpRouteDeployConfigSchemaErrors = {
  ONLY_SYNTHETIC_REBASE: `Config with ${TokenType.collateralVaultRebase} must be deployed with ${TokenType.syntheticRebase}`,
  NO_SYNTHETIC_ONLY: `Config must include Native or Collateral OR all synthetics must define token metadata`,
};
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
    TokenType.collateralVault,
    TokenType.collateralVaultRebase,
    TokenType.XERC20,
    TokenType.XERC20Lockbox,
    TokenType.collateralFiat,
    TokenType.fastCollateral,
    TokenType.collateralUri,
  ]),
  token: z
    .string()
    .describe('Existing token address to extend with Warp Route functionality'),
});

export const NativeConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([TokenType.native, TokenType.nativeScaled]),
});

export const CollateralRebaseConfigSchema = TokenMetadataSchema.omit({
  totalSupply: true,
})
  .partial()
  .extend({
    type: z.literal(TokenType.collateralVaultRebase),
  });

export const SyntheticRebaseConfigSchema = TokenMetadataSchema.partial().extend(
  {
    type: z.literal(TokenType.syntheticRebase),
    collateralChainName: z.string(),
  },
);

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
  SyntheticRebaseConfigSchema,
]);
export type TokenConfig = z.infer<typeof TokenConfigSchema>;

export const TokenRouterConfigSchema = TokenConfigSchema.and(
  GasRouterConfigSchema,
);

export type TokenRouterConfig = z.infer<typeof TokenRouterConfigSchema>;
export type NativeConfig = z.infer<typeof NativeConfigSchema>;
export type CollateralConfig = z.infer<typeof CollateralConfigSchema>;

export const isSyntheticConfig = isCompliant(SyntheticConfigSchema);
export const isSyntheticRebaseConfig = isCompliant(SyntheticRebaseConfigSchema);
export const isCollateralRebaseConfig = isCompliant(
  CollateralRebaseConfigSchema,
);
export const isCollateralConfig = isCompliant(CollateralConfigSchema);
export const isNativeConfig = isCompliant(NativeConfigSchema);
export const isTokenMetadata = isCompliant(TokenMetadataSchema);

export const WarpRouteDeployConfigSchema = z
  .record(TokenRouterConfigSchema)
  .refine((configMap) => {
    const entries = Object.entries(configMap);
    return (
      entries.some(
        ([_, config]) =>
          isCollateralConfig(config) ||
          isCollateralRebaseConfig(config) ||
          isNativeConfig(config),
      ) || entries.every(([_, config]) => isTokenMetadata(config))
    );
  }, WarpRouteDeployConfigSchemaErrors.NO_SYNTHETIC_ONLY)
  .transform((warpRouteDeployConfig, ctx) => {
    const collateralRebaseEntry = Object.entries(warpRouteDeployConfig).find(
      ([_, config]) => isCollateralRebaseConfig(config),
    );
    if (!collateralRebaseEntry) return warpRouteDeployConfig; // Pass through for other token types

    if (isCollateralRebasePairedCorrectly(warpRouteDeployConfig)) {
      const collateralChainName = collateralRebaseEntry[0];
      return objMap(warpRouteDeployConfig, (_, config) => {
        if (config.type === TokenType.syntheticRebase)
          config.collateralChainName = collateralChainName;
        return config;
      }) as Record<string, TokenRouterConfig>;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
    });

    return z.NEVER; // Causes schema validation to throw with above issue
  });

function isCollateralRebasePairedCorrectly(
  warpRouteDeployConfig: Record<string, TokenRouterConfig>,
): boolean {
  // Filter out all the non-collateral rebase configs to check if they are only synthetic rebase tokens
  const otherConfigs = Object.entries(warpRouteDeployConfig).filter(
    ([_, config]) => !isCollateralRebaseConfig(config),
  );

  if (otherConfigs.length === 0) return false;

  // The other configs MUST be synthetic rebase
  const allOthersSynthetic: boolean = otherConfigs.every(
    ([_, config], _index) => isSyntheticRebaseConfig(config),
  );
  return allOthersSynthetic;
}
