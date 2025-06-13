import { expect } from 'chai';

import { ChainMap } from '@hyperlane-xyz/sdk';

import { type BridgeConfig, getBridgeConfig } from './bridgeUtils.js';

describe('bridgeConfig', () => {
  it('should return the base bridge config when no overrides exist', () => {
    const bridges: ChainMap<BridgeConfig> = {
      chain1: {
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        bridgeIsWarp: true,
      },
      chain2: {
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
        bridgeIsWarp: true,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      bridge: '0x1234567890123456789012345678901234567890',
      bridgeMinAcceptedAmount: 1000,
      bridgeIsWarp: true,
    });
  });

  it('should merge base config with overrides when they exist', () => {
    const bridges: ChainMap<BridgeConfig> = {
      chain1: {
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        bridgeIsWarp: true,
        overrides: {
          chain2: {
            bridgeMinAcceptedAmount: 5000,
          },
        },
      },
      chain2: {
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
        bridgeIsWarp: true,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      bridge: '0x1234567890123456789012345678901234567890',
      bridgeMinAcceptedAmount: 5000,
      bridgeIsWarp: true,
    });
  });

  it('should handle overrides that change the bridge address', () => {
    const bridges: ChainMap<BridgeConfig> = {
      chain1: {
        bridge: '0x1234567890123456789012345678901234567890',
        bridgeMinAcceptedAmount: 1000,
        bridgeIsWarp: true,
        overrides: {
          chain2: {
            bridge: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
          },
        },
      },
      chain2: {
        bridge: '0x0987654321098765432109876543210987654321',
        bridgeMinAcceptedAmount: 2000,
        bridgeIsWarp: true,
      },
    };

    const result = getBridgeConfig(bridges, 'chain1', 'chain2');

    expect(result).to.deep.equal({
      bridge: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      bridgeMinAcceptedAmount: 1000,
      bridgeIsWarp: true,
    });
  });
});
