import { z } from 'zod';

import { GasRouterConfigSchema } from '../router/types.js';
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
export type TokenMetadata = z.infer<typeof TokenMetadataSchema>;
export const isTokenMetadata = isCompliant(TokenMetadataSchema);

export const NativeTokenConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([TokenType.native, TokenType.nativeScaled]),
});
export type NativeTokenConfig = z.infer<typeof NativeTokenConfigSchema>;
export const isNativeTokenConfig = isCompliant(NativeTokenConfigSchema);

export const CollateralTokenConfigSchema = TokenMetadataSchema.partial().extend(
  {
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
      .describe(
        'Existing token address to extend with Warp Route functionality',
      ),
  },
);
export type CollateralTokenConfig = z.infer<typeof CollateralTokenConfigSchema>;
export const isCollateralTokenConfig = isCompliant(CollateralTokenConfigSchema);

export const CollateralRebaseTokenConfigSchema = TokenMetadataSchema.omit({
  totalSupply: true,
})
  .partial()
  .extend({
    type: z.literal(TokenType.collateralVaultRebase),
  });
export const isCollateralRebaseTokenConfig = isCompliant(
  CollateralRebaseTokenConfigSchema,
);

export const SyntheticTokenConfigSchema = TokenMetadataSchema.partial().extend({
  type: z.enum([
    TokenType.synthetic,
    TokenType.syntheticUri,
    TokenType.fastSynthetic,
  ]),
});
export type SyntheticTokenConfig = z.infer<typeof CollateralTokenConfigSchema>;
export const isSyntheticTokenConfig = isCompliant(SyntheticTokenConfigSchema);

export const SyntheticRebaseTokenConfigSchema =
  TokenMetadataSchema.partial().extend({
    type: z.literal(TokenType.syntheticRebase),
    collateralChainName: z.string(),
  });
export type SyntheticRebaseTokenConfig = z.infer<
  typeof CollateralTokenConfigSchema
>;
export const isSyntheticRebaseTokenConfig = isCompliant(
  SyntheticRebaseTokenConfigSchema,
);

/**
 * @remarks
 * The discriminatedUnion is basically a switch statement for zod schemas
 * It uses the 'type' key to pick from the array of schemas to validate
 */
export const HypTokenConfigSchema = z.discriminatedUnion('type', [
  NativeTokenConfigSchema,
  CollateralTokenConfigSchema,
  SyntheticTokenConfigSchema,
  SyntheticRebaseTokenConfigSchema,
]);
export type HypTokenConfig = z.infer<typeof HypTokenConfigSchema>;

export const HypTokenRouterConfigSchema = HypTokenConfigSchema.and(
  GasRouterConfigSchema,
);
export type HypTokenRouterConfig = z.infer<typeof HypTokenRouterConfigSchema>;

export const HypTokenRouterConfigWithoutMailboxSchema =
  HypTokenConfigSchema.and(GasRouterConfigSchema.omit({ mailbox: true }));
export type HypTokenRouterConfigWithoutMailbox = z.infer<
  typeof HypTokenRouterConfigWithoutMailboxSchema
>;

function validateWarpRouteConfig(
  configMap: Record<string, any>,
  ctx: z.RefinementCtx,
) {
  const entries = Object.entries(configMap);
  const isValid =
    entries.some(
      ([_, config]) =>
        isCollateralTokenConfig(config) ||
        isCollateralRebaseTokenConfig(config) ||
        isNativeTokenConfig(config),
    ) || entries.every(([_, config]) => isTokenMetadata(config));

  if (!isValid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: WarpRouteDeployConfigSchemaErrors.NO_SYNTHETIC_ONLY,
    });
    return;
  }

  const collateralRebaseEntry = entries.find(([_, config]) =>
    isCollateralRebaseTokenConfig(config),
  );
  if (!collateralRebaseEntry) return;

  if (!isCollateralRebasePairedCorrectly(configMap)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
    });
  }
}

export const WarpRouteDeployConfigSchema = z
  .record(HypTokenRouterConfigSchema)
  .superRefine(validateWarpRouteConfig)
  .transform((config) => config as Record<string, HypTokenRouterConfig>);

export const WarpRouteDeployConfigSchemaWithoutMailbox = z
  .record(HypTokenRouterConfigWithoutMailboxSchema)
  .superRefine(validateWarpRouteConfig)
  .transform(
    (config) => config as Record<string, HypTokenRouterConfigWithoutMailbox>,
  );

export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;
export type WarpRouteDeployConfigWithoutMailbox = z.infer<
  typeof WarpRouteDeployConfigSchemaWithoutMailbox
>;

function isCollateralRebasePairedCorrectly(
  warpRouteDeployConfig: Record<string, HypTokenRouterConfig>,
): boolean {
  // Filter out all the non-collateral rebase configs to check if they are only synthetic rebase tokens
  const otherConfigs = Object.entries(warpRouteDeployConfig).filter(
    ([_, config]) => !isCollateralRebaseTokenConfig(config),
  );

  if (otherConfigs.length === 0) return false;

  // The other configs MUST be synthetic rebase
  const allOthersSynthetic: boolean = otherConfigs.every(
    ([_, config], _index) => isSyntheticRebaseTokenConfig(config),
  );
  return allOthersSynthetic;
}
