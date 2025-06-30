import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { rebalancerLogger } from './loggerUtils.js';

export type BridgeConfigWithOverride = BridgeConfig & {
  override?: ChainMap<Partial<BridgeConfig>>;
};

export type BridgeConfig = {
  bridge: string;
  bridgeMinAcceptedAmount: string | number;
  bridgeIsWarp: boolean;
};

/**
 * Gets the bridge configuration for a specific chain pair, applying any overrides
 * @param bridges The map of bridge configurations by chain
 * @param fromChain The source chain
 * @param toChain The destination chain
 * @returns The bridge configuration with any overrides applied
 */
export function getBridgeConfig(
  bridges: ChainMap<BridgeConfigWithOverride>,
  fromChain: ChainName,
  toChain: ChainName,
): BridgeConfig {
  const fromConfig = bridges[fromChain];

  if (!fromConfig) {
    rebalancerLogger.error({ fromChain }, 'Bridge config not found');
    throw new Error(`Bridge config not found for chain ${fromChain}`);
  }

  const routeSpecificOverrides = fromConfig.override?.[toChain];

  // Create a new object with the properties from bridgeConfig, excluding the overrides property
  const { override: _, ...baseConfig } = fromConfig;

  // Return a new object with the base config and any overrides
  return { ...baseConfig, ...routeSpecificOverrides };
}
