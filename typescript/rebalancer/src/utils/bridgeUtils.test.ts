import assert from 'node:assert';

import { expect } from 'chai';

import { type ChainMap } from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  TokenBridgeStatusAdapterType,
} from '../config/types.js';
import {
  type BridgeConfigWithOverride,
  createStrategyRoute,
  getBridgeConfig,
  isInventoryConfig,
  isMovableCollateralConfig,
} from './bridgeUtils.js';

describe('bridgeConfig', () => {
  it('should return the base bridge config when no overrides exist', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: 'movableCollateral',
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
      },
      chain2: {
        executionType: 'movableCollateral',
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      executionType: 'movableCollateral',
      bridge: '0x1234567890123456789012345678901234567890',
      bridgeMinAcceptedAmount: 1000,
    });
  });

  it('should merge base config with overrides when they exist', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: 'movableCollateral',
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        override: {
          chain2: {
            bridgeMinAcceptedAmount: 5000,
          },
        },
      },
      chain2: {
        executionType: 'movableCollateral',
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      executionType: 'movableCollateral',
      bridge: '0x1234567890123456789012345678901234567890',
      bridgeMinAcceptedAmount: 5000,
    });
  });

  it('should handle overrides that change the bridge address', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: 'movableCollateral',
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        override: {
          chain2: {
            bridge: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
          },
        },
      },
      chain2: {
        executionType: 'movableCollateral',
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      executionType: 'movableCollateral',
      bridge: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      bridgeMinAcceptedAmount: 1000,
    });
  });

  it('should apply and propagate a destination settlement adapter override', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x1234567890123456789012345678901234567890',
        override: {
          chain2: {
            statusAdapter: {
              kind: TokenBridgeStatusAdapterType.LayerZeroScan,
              sourceEid: 30110,
              destinationEid: 30420,
              sourceOft: '0x1111111111111111111111111111111111111111',
              destinationOft: '0x2222222222222222222222222222222222222222',
            },
          },
        },
      },
      chain2: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x0987654321098765432109876543210987654321',
      },
    };

    const config = getBridgeConfig(bridges, 'chain1', 'chain2');
    const route = createStrategyRoute(config, 'chain1', 'chain2', 100n);

    assert(isMovableCollateralConfig(config));
    expect(config.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
    assert(route.executionType === ExecutionType.MovableCollateral);
    expect(route.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
  });

  it('should switch an inventory base to a movable collateral override', () => {
    const bridge = '0x1234567890123456789012345678901234567890';
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.Inventory,
        externalBridge: ExternalBridgeType.SwapsXyz,
        override: {
          chain2: {
            executionType: ExecutionType.MovableCollateral,
            bridge,
            statusAdapter: {
              kind: TokenBridgeStatusAdapterType.LayerZeroScan,
              sourceEid: 30110,
              destinationEid: 30420,
              sourceOft: '0x1111111111111111111111111111111111111111',
              destinationOft: '0x2222222222222222222222222222222222222222',
            },
          },
        },
      },
      chain2: {
        executionType: ExecutionType.Inventory,
        externalBridge: ExternalBridgeType.SwapsXyz,
      },
    };

    const config = getBridgeConfig(bridges, 'chain1', 'chain2');
    const route = createStrategyRoute(config, 'chain1', 'chain2', 100n);

    assert(isMovableCollateralConfig(config));
    expect(config.bridge).to.equal(bridge);
    expect(config.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
    assert(route.executionType === ExecutionType.MovableCollateral);
    expect(route.bridge).to.equal(bridge);
    expect(route.statusAdapter?.kind).to.equal(
      TokenBridgeStatusAdapterType.LayerZeroScan,
    );
  });

  it('should apply override with executionType: inventory', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        override: {
          chain2: {
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
        },
      },
      chain2: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result.executionType).to.equal(ExecutionType.Inventory);
    assert(isInventoryConfig(result));
    expect(result.externalBridge).to.equal(ExternalBridgeType.LiFi);
    expect(result.bridgeMinAcceptedAmount).to.equal(1000);
  });
  it('should apply override with executionType: inventory and externalBridge', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x1234567890123456789012345678901234567890',
        override: {
          chain2: {
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
        },
      },
      chain2: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x0987654321098765432109876543210987654321',
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result.executionType).to.equal(ExecutionType.Inventory);
    assert(isInventoryConfig(result));
    expect(result.externalBridge).to.equal(ExternalBridgeType.LiFi);
  });

  it('should allow override to change executionType from movableCollateral to inventory', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x1234567890123456789012345678901234567890',
        override: {
          chain2: {
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
        },
      },
      chain2: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x0987654321098765432109876543210987654321',
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    // Override should win: executionType should be inventory, not movableCollateral
    expect(result.executionType).to.equal(ExecutionType.Inventory);
    assert(isInventoryConfig(result));
    expect(result.externalBridge).to.equal(ExternalBridgeType.LiFi);
  });

  it('should preserve base chain executionType when no override exists', () => {
    const bridges: ChainMap<BridgeConfigWithOverride> = {
      chain1: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x1234567890123456789012345678901234567890',
      },
      chain2: {
        executionType: ExecutionType.MovableCollateral,
        bridge: '0x0987654321098765432109876543210987654321',
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result.executionType).to.equal(ExecutionType.MovableCollateral);
    assert(isMovableCollateralConfig(result));
    expect(result.bridge).to.equal(
      '0x1234567890123456789012345678901234567890',
    );
  });
});
