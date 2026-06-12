import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { assert, type Address } from '@hyperlane-xyz/utils';

import { ExecutionType, type ExternalBridgeType } from '../config/types.js';
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

export type RouteExecutionMatrix = ChainMap<ChainMap<BridgeConfig>>;

export type RouteExecutionConfigInput = BaseBridgeConfig & {
  executionType?: ExecutionType | BridgeConfig['executionType'];
  bridge?: Address;
  externalBridge?: ExternalBridgeType;
  override?: ChainMap<Partial<RouteExecutionConfigInput>>;
};

export type RouteExecutionConfigInputMap = ChainMap<RouteExecutionConfigInput>;

export function resolveRouteExecutionConfig(
  config: RouteExecutionConfigInput,
): BridgeConfig {
  const executionType = config.executionType ?? ExecutionType.MovableCollateral;

  if (executionType === ExecutionType.Inventory) {
    assert(
      config.externalBridge,
      'externalBridge is required for inventory execution',
    );
    return {
      executionType: 'inventory',
      externalBridge: config.externalBridge,
      bridgeMinAcceptedAmount: config.bridgeMinAcceptedAmount,
    };
  }

  assert(config.bridge, 'bridge is required for movableCollateral execution');
  return {
    executionType: 'movableCollateral',
    bridge: config.bridge,
    bridgeMinAcceptedAmount: config.bridgeMinAcceptedAmount,
  };
}

export function buildBridgeConfigMapFromConfig(
  chainConfigs: RouteExecutionConfigInputMap,
): ChainMap<BridgeConfigWithOverride> {
  const bridgeConfigs: ChainMap<BridgeConfigWithOverride> = {};

  for (const [origin, originConfig] of Object.entries(chainConfigs)) {
    const override: ChainMap<Partial<BridgeConfig>> = {};

    for (const [destination, destinationOverride] of Object.entries(
      originConfig.override ?? {},
    )) {
      override[destination] = resolveRouteExecutionConfig({
        ...originConfig,
        ...destinationOverride,
      });
    }

    const resolved = resolveRouteExecutionConfig(originConfig);
    bridgeConfigs[origin] = {
      ...resolved,
      override: Object.keys(override).length > 0 ? override : undefined,
    };
  }

  return bridgeConfigs;
}

export function buildRouteExecutionMatrix(
  bridges: ChainMap<BridgeConfigWithOverride>,
  chains = Object.keys(bridges),
): RouteExecutionMatrix {
  const matrix: RouteExecutionMatrix = {};

  for (const origin of chains) {
    const originConfig = bridges[origin];
    assert(originConfig, `Missing bridge config for chain ${origin}`);
    matrix[origin] = {};

    for (const destination of chains) {
      if (origin === destination) {
        continue;
      }

      matrix[origin][destination] = getBridgeConfig(
        bridges,
        origin,
        destination,
      );
    }
  }

  return matrix;
}

export function normalizeRouteExecutionMatrix(
  config: ChainMap<BridgeConfigWithOverride>,
): RouteExecutionMatrix {
  return buildRouteExecutionMatrix(config);
}

export function getRouteExecutionConfig(
  matrix: RouteExecutionMatrix,
  origin: ChainName,
  destination: ChainName,
): BridgeConfig {
  const originMatrix = matrix[origin];
  assert(originMatrix, `Missing route execution config for origin ${origin}`);
  const routeConfig = originMatrix[destination];
  assert(
    routeConfig,
    `Missing route execution config for ${origin} -> ${destination}`,
  );
  return routeConfig;
}

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
  assert(fromConfig, `Missing bridge config for chain ${fromChain}`);
  const routeSpecificOverrides = fromConfig.override?.[toChain];

  const { override: _, ...baseConfig } = fromConfig;

  return resolveRouteExecutionConfig({
    ...baseConfig,
    ...routeSpecificOverrides,
  });
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
