import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export type BridgeConfig = {
  bridge: string;
  bridgeMinAcceptedAmount: bigint;
  bridgeIsWarp: boolean;
  overrides?: ChainMap<Partial<BridgeConfig>>;
};

/**
 * Gets the bridge configuration for a specific chain pair, applying any overrides
 * @param bridges The map of bridge configurations by chain
 * @param fromChain The source chain
 * @param toChain The destination chain
 * @returns The bridge configuration with any overrides applied
 */
export function getBridgeConfig(
  bridges: ChainMap<BridgeConfig>,
  fromChain: ChainName,
  toChain: ChainName,
): BridgeConfig {
  const fromConfig = bridges[fromChain];
  const routeSpecificOverrides = fromConfig.overrides?.[toChain];

  // Create a new object with the properties from bridgeConfig, excluding the overrides property
  const { overrides: _, ...baseConfig } = fromConfig;

  // Return a new object with the base config and any overrides
  return { ...baseConfig, ...routeSpecificOverrides };
}
