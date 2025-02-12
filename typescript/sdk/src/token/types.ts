import { z } from 'zod';

import { objMap } from '@hyperlane-xyz/utils';

import { HookConfig, HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { GasRouterConfigSchema } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';
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

export const WarpRouteDeployConfigSchema = z
  .record(HypTokenRouterConfigSchema)
  .refine((configMap) => {
    const entries = Object.entries(configMap);
    return (
      entries.some(
        ([_, config]) =>
          isCollateralTokenConfig(config) ||
          isCollateralRebaseTokenConfig(config) ||
          isNativeTokenConfig(config),
      ) || entries.every(([_, config]) => isTokenMetadata(config))
    );
  }, WarpRouteDeployConfigSchemaErrors.NO_SYNTHETIC_ONLY)
  // Verify synthetic rebase tokens config
  .transform((warpRouteDeployConfig, ctx) => {
    const collateralRebaseEntry = Object.entries(warpRouteDeployConfig).find(
      ([_, config]) => isCollateralRebaseTokenConfig(config),
    );

    const syntheticRebaseEntry = Object.entries(warpRouteDeployConfig).find(
      ([_, config]) => isSyntheticRebaseTokenConfig(config),
    );

    // Require both collateral rebase and synthetic rebase to be present in the config
    if (!collateralRebaseEntry && !syntheticRebaseEntry) {
      //  Pass through for other token types
      return warpRouteDeployConfig;
    }

    if (
      collateralRebaseEntry &&
      isCollateralRebasePairedCorrectly(warpRouteDeployConfig)
    ) {
      const collateralChainName = collateralRebaseEntry[0];
      return objMap(warpRouteDeployConfig, (_, config) => {
        if (config.type === TokenType.syntheticRebase)
          config.collateralChainName = collateralChainName;
        return config;
      }) as Record<string, HypTokenRouterConfig>;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
    });

    return z.NEVER; // Causes schema validation to throw with above issue
  })
  // Verify that CCIP hooks are paired with CCIP ISMs
  .transform((warpRouteDeployConfig, ctx) => {
    const { ccipHookMap, ccipIsmMap } = getCCIPConfigMaps(
      warpRouteDeployConfig,
    );

    // Check hooks have corresponding ISMs
    const hookConfigHasMissingIsms = Object.entries(ccipHookMap).some(
      ([originChain, validDestinationChains]) => {
        if (!ccipIsmMap[originChain]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `No CCIP ISM found in config for origin chain ${originChain}`,
          });
          return true;
        }

        return Array.from(validDestinationChains).some((chain) => {
          if (!ccipIsmMap[originChain].has(chain)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [chain, 'interchainSecurityModule', '...'],
              message: `Required CCIP ISM not found in config for CCIP Hook with origin chain ${originChain} and destination chain ${chain}`,
            });
            return true;
          }
          return false;
        });
      },
    );

    // Check ISMs have corresponding hooks
    const ismConfigHasMissingHooks = Object.entries(ccipIsmMap).some(
      ([originChain, destinationChains]) =>
        Array.from(destinationChains).some((chain) => {
          if (!ccipHookMap[originChain]?.has(chain)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [originChain, 'hook', '...'],
              message: `Required CCIP Hook not found in config for CCIP ISM with origin chain ${originChain} and destination chain ${chain}`,
            });
            return true;
          }
          return false;
        }),
    );

    return hookConfigHasMissingIsms || ismConfigHasMissingHooks
      ? z.NEVER
      : warpRouteDeployConfig;
  });

export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;

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

/**
 * Map tracking which chains can be CCIP destinations for each origin chain.
 * { [origin chain]: Set<valid destination chain> }
 */
type CCIPContractExistsMap = ChainMap<Set<ChainName>>;

function getCCIPConfigMaps(
  warpRouteDeployConfig: Record<string, HypTokenRouterConfig>,
): {
  ccipHookMap: CCIPContractExistsMap;
  ccipIsmMap: CCIPContractExistsMap;
} {
  const ccipHookMap: CCIPContractExistsMap = {};
  const ccipIsmMap: CCIPContractExistsMap = {};

  Object.entries(warpRouteDeployConfig).forEach(([chainName, config]) => {
    extractCCIPHookMap(chainName, config.hook, ccipHookMap);
    extractCCIPIsmMap(chainName, config.interchainSecurityModule, ccipIsmMap);
  });

  return { ccipHookMap, ccipIsmMap };
}

function extractCCIPHookMap(
  currentChain: ChainName,
  hookConfig: HookConfig | undefined,
  existsCCIPHookMap: CCIPContractExistsMap,
) {
  if (!hookConfig || typeof hookConfig === 'string') {
    return;
  }

  switch (hookConfig.type) {
    case HookType.AGGREGATION:
      hookConfig.hooks.forEach((hook) =>
        extractCCIPHookMap(currentChain, hook, existsCCIPHookMap),
      );
      break;
    case HookType.ARB_L2_TO_L1:
      extractCCIPHookMap(currentChain, hookConfig.childHook, existsCCIPHookMap);
      break;
    case HookType.CCIP:
      if (!existsCCIPHookMap[currentChain]) {
        existsCCIPHookMap[currentChain] = new Set();
      }
      existsCCIPHookMap[currentChain].add(hookConfig.destinationChain);
      break;
    case HookType.FALLBACK_ROUTING:
    case HookType.ROUTING:
      Object.entries(hookConfig.domains).forEach(([_, hook]) => {
        extractCCIPHookMap(currentChain, hook, existsCCIPHookMap);
      });
      break;
    case HookType.INTERCHAIN_GAS_PAYMASTER:
    case HookType.MERKLE_TREE:
    case HookType.OP_STACK:
    case HookType.PAUSABLE:
    case HookType.PROTOCOL_FEE:
      break;
  }
}

function extractCCIPIsmMap(
  currentChain: ChainName,
  ismConfig: IsmConfig | undefined,
  existsCCIPIsmMap: CCIPContractExistsMap,
) {
  if (!ismConfig || typeof ismConfig === 'string') {
    return;
  }

  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      ismConfig.modules.forEach((hook) =>
        extractCCIPIsmMap(currentChain, hook, existsCCIPIsmMap),
      );
      break;
    case IsmType.CCIP:
      if (!existsCCIPIsmMap[ismConfig.originChain]) {
        existsCCIPIsmMap[ismConfig.originChain] = new Set();
      }
      existsCCIPIsmMap[ismConfig.originChain].add(currentChain);
      break;
    case IsmType.FALLBACK_ROUTING:
    case IsmType.ROUTING:
      Object.entries(ismConfig.domains).forEach(([_, hook]) => {
        extractCCIPIsmMap(currentChain, hook, existsCCIPIsmMap);
      });
      break;
    case IsmType.ARB_L2_TO_L1:
    case IsmType.ICA_ROUTING:
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.PAUSABLE:
    case IsmType.OP_STACK:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
    case IsmType.TEST_ISM:
    case IsmType.TRUSTED_RELAYER:
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
      break;
  }
}
