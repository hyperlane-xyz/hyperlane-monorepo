import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../config/types.js';
import type { StrategyRoute } from '../interfaces/IStrategy.js';

type BaseBridgeConfig = {
  bridgeMinAcceptedAmount?: string | number;
};

export type MovableCollateralBridgeConfig = BaseBridgeConfig & {
  executionType: 'movableCollateral';
  bridge: Address;
};

export type InventoryBridgeConfig = BaseBridgeConfig & {
  executionType: 'inventory';
  externalBridge: ExternalBridgeType;
};

export type BridgeConfig =
  | MovableCollateralBridgeConfig
  | InventoryBridgeConfig;

export function isMovableCollateralConfig(
  config: BridgeConfig,
): config is MovableCollateralBridgeConfig {
  return config.executionType === 'movableCollateral';
}

export function isInventoryConfig(
  config: BridgeConfig,
): config is InventoryBridgeConfig {
  return config.executionType === 'inventory';
}

export type BridgeConfigWithOverride = BridgeConfig & {
  override?: ChainMap<Partial<BridgeConfig>>;
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
  const routeSpecificOverrides = fromConfig.override?.[toChain];

  // Create a new object with the properties from bridgeConfig, excluding the overrides property
  const { override: _, ...baseConfig } = fromConfig;

  // Return a new object with the base config and any overrides
  return { ...baseConfig, ...routeSpecificOverrides } as BridgeConfig;
}

/**
 * Creates a StrategyRoute from a BridgeConfig with exhaustive type checking
 * @param bridgeConfig The bridge configuration
 * @param origin The origin chain
 * @param destination The destination chain
 * @param amount The amount to transfer
 * @returns A StrategyRoute with the appropriate execution type
 */
export function createStrategyRoute(
  bridgeConfig: BridgeConfig,
  origin: ChainName,
  destination: ChainName,
  amount: bigint,
): StrategyRoute {
  switch (bridgeConfig.executionType) {
    case 'inventory':
      return {
        origin,
        destination,
        amount,
        executionType: 'inventory',
        externalBridge: bridgeConfig.externalBridge,
      };
    case 'movableCollateral':
      return {
        origin,
        destination,
        amount,
        executionType: 'movableCollateral',
        bridge: bridgeConfig.bridge,
      };
    default: {
      const _exhaustive: never = bridgeConfig;
      throw new Error(
        `Unknown execution type: ${(_exhaustive as BridgeConfig).executionType}`,
      );
    }
  }
}
