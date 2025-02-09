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
    // Get all the CCIP hooks and ISMs by origin->destination chain
    const ccipHooks = getCCIPHooks(warpRouteDeployConfig);
    const ccipIsms = getCCIPIsms(warpRouteDeployConfig);

    let isPairedCorrectly = true;
    Object.entries(ccipHooks).forEach(([originChain, hooks]) => {
      if (!ccipIsms[originChain]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No CCIP ISM found in config for origin chain ${originChain}`,
        });

        isPairedCorrectly &&= false;
      }

      Object.entries(hooks).forEach(([destinationChain, _]) => {
        if (!ccipIsms[originChain][destinationChain]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [destinationChain, 'interchainSecurityModule', '...'],
            message: `Required CCIP ISM not found in config for CCIP Hook with origin chain ${originChain} and destination chain ${destinationChain}`,
          });

          isPairedCorrectly &&= false;
        }
      });
    });

    Object.entries(ccipIsms).forEach(([destinationChain, hooks]) => {
      Object.entries(hooks).forEach(([originChain, _]) => {
        if (
          !ccipHooks[originChain] ||
          !ccipHooks[originChain][destinationChain]
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [originChain, 'hook', '...'],
            message: `Required CCIP Hook not found in config for CCIP ISM with origin chain ${originChain} and destination chain ${destinationChain}`,
          });

          isPairedCorrectly &&= false;
        }
      });
    }, true);

    if (!isPairedCorrectly) {
      return z.NEVER;
    }

    return warpRouteDeployConfig;
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

function getCCIPHooks(
  warpRouteDeployConfig: Record<string, HypTokenRouterConfig>,
): ChainMap<ChainMap<boolean>> {
  const hooks: ChainMap<ChainMap<boolean>> = {};

  Object.entries(warpRouteDeployConfig).forEach(([chainName, config]) => {
    if (!config.hook) {
      return;
    }

    if (typeof config.hook === 'string') {
      return;
    }

    traverseHookConfig(chainName, config.hook, hooks);
  });

  return hooks;
}

function traverseHookConfig(
  currentChain: ChainName,
  hookConfig: HookConfig,
  existsCCIPHookMap: ChainMap<ChainMap<boolean>>,
) {
  if (typeof hookConfig === 'string') {
    return;
  }

  switch (hookConfig.type) {
    case HookType.AGGREGATION:
      hookConfig.hooks.forEach((hook) =>
        traverseHookConfig(currentChain, hook, existsCCIPHookMap),
      );
      break;
    case HookType.ARB_L2_TO_L1:
      if (hookConfig.childHook) {
        traverseHookConfig(
          currentChain,
          hookConfig.childHook,
          existsCCIPHookMap,
        );
      }
      break;
    case HookType.CCIP:
      existsCCIPHookMap[currentChain] = existsCCIPHookMap[currentChain] || {};
      existsCCIPHookMap[currentChain][hookConfig.destinationChain] = true;
      break;
    case HookType.FALLBACK_ROUTING:
    case HookType.ROUTING:
      Object.entries(hookConfig.domains).forEach(([_, hook]) => {
        traverseHookConfig(currentChain, hook, existsCCIPHookMap);
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

function getCCIPIsms(
  warpRouteDeployConfig: Record<string, HypTokenRouterConfig>,
): ChainMap<ChainMap<boolean>> {
  const isms: ChainMap<ChainMap<boolean>> = {};

  Object.entries(warpRouteDeployConfig).forEach(([chainName, config]) => {
    if (!config.interchainSecurityModule) {
      return;
    }

    if (typeof config.interchainSecurityModule === 'string') {
      return;
    }

    traverseIsmConfig(chainName, config.interchainSecurityModule, isms);
  });

  return isms;
}

function traverseIsmConfig(
  currentChain: ChainName,
  ismConfig: IsmConfig,
  existsCCIPIsmMap: ChainMap<ChainMap<boolean>>,
) {
  if (typeof ismConfig === 'string') {
    return;
  }

  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      ismConfig.modules.forEach((hook) =>
        traverseIsmConfig(currentChain, hook, existsCCIPIsmMap),
      );
      break;
    case IsmType.CCIP:
      existsCCIPIsmMap[ismConfig.originChain] =
        existsCCIPIsmMap[ismConfig.originChain] || {};
      existsCCIPIsmMap[ismConfig.originChain][currentChain] = true;
      break;
    case IsmType.FALLBACK_ROUTING:
    case IsmType.ROUTING:
      Object.entries(ismConfig.domains).forEach(([_, hook]) => {
        traverseIsmConfig(currentChain, hook, existsCCIPIsmMap);
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
