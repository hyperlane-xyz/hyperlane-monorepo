import { expect } from 'chai';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import type { CommandContext } from '../context/types.js';

import { getWarpCoreConfigOrExit, resolveWarpRouteId } from './warp.js';

describe('resolveWarpRouteId', () => {
  const mockWarpRoutes = {
    'ETH/ethereum-arbitrum': {},
    'ETH/ethereum-optimism': {},
    'USDC/circle': {},
  };

  const mockWarpDeployConfig = {
    'ETH/ethereum-arbitrum': {},
    'USDC/circle': {},
  };

  const mockWarpCoreConfigs: Record<string, WarpCoreConfig> = {
    'ETH/ethereum-arbitrum': {
      tokens: [
        { chainName: 'ethereum', addressOrDenom: '0x1' },
        { chainName: 'arbitrum', addressOrDenom: '0x2' },
      ],
    } as WarpCoreConfig,
    'ETH/ethereum-optimism': {
      tokens: [
        { chainName: 'ethereum', addressOrDenom: '0x3' },
        { chainName: 'optimism', addressOrDenom: '0x4' },
      ],
    } as WarpCoreConfig,
    'USDC/circle': {
      tokens: [
        { chainName: 'ethereum', addressOrDenom: '0x5' },
        { chainName: 'arbitrum', addressOrDenom: '0x6' },
        { chainName: 'optimism', addressOrDenom: '0x7' },
      ],
    } as WarpCoreConfig,
  };

  const createMockRegistry = (
    warpRoutes: Record<string, any> = mockWarpRoutes,
    warpDeployConfig: Record<string, any> = mockWarpDeployConfig,
    warpCoreConfigs: Record<string, WarpCoreConfig> = mockWarpCoreConfigs,
  ): IRegistry =>
    ({
      listRegistryContent: async () => ({
        deployments: {
          warpRoutes,
          warpDeployConfig,
        },
      }),
      getWarpRoutes: async ({ symbol }: { symbol?: string }) => {
        if (!symbol) return warpCoreConfigs;
        const upperSymbol = symbol.toUpperCase();
        return Object.fromEntries(
          Object.entries(warpCoreConfigs).filter(([id]) =>
            id.startsWith(`${upperSymbol}/`),
          ),
        );
      },
      getWarpRoute: async (routeId: string) => {
        return warpCoreConfigs[routeId] || null;
      },
    }) as IRegistry;

  const createMockContext = (
    skipConfirmation: boolean = false,
    registry: IRegistry = createMockRegistry(),
  ): CommandContext =>
    ({
      registry,
      skipConfirmation,
    }) as CommandContext;

  it('should return warp route ID unchanged when it contains a slash', async () => {
    const context = createMockContext();
    const result = await resolveWarpRouteId({
      context,
      warpRouteId: 'ETH/ethereum-arbitrum',
    });

    expect(result).to.equal('ETH/ethereum-arbitrum');
  });

  it('should throw when a full warp route ID does not exist', async () => {
    const context = createMockContext();
    try {
      await resolveWarpRouteId({
        context,
        warpRouteId: 'ETH/does-not-exist',
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'No warp route found with ID "ETH/does-not-exist"',
      );
    }
  });

  it('should throw explicit error for legacy symbol/warp params', async () => {
    const context = createMockContext();
    try {
      await resolveWarpRouteId({
        context,
        symbol: 'ETH',
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Legacy "symbol"/"warp" params are not supported',
      );
    }
  });

  it('should return the single matching route when symbol matches one route', async () => {
    const context = createMockContext();
    const result = await resolveWarpRouteId({
      context,
      warpRouteId: 'usdc',
    });

    expect(result).to.equal('USDC/circle');
  });

  it('should throw error with list when multiple routes match and skipConfirmation is true', async () => {
    const context = createMockContext(true);
    try {
      await resolveWarpRouteId({
        context,
        warpRouteId: 'eth',
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Multiple warp routes found for symbol "ETH"',
      );
      expect((error as Error).message).to.include('ETH/ethereum-arbitrum');
      expect((error as Error).message).to.include('ETH/ethereum-optimism');
    }
  });

  it('should throw explicit error when no routes match the symbol', async () => {
    const context = createMockContext();
    try {
      await resolveWarpRouteId({
        context,
        warpRouteId: 'NONEXISTENT',
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'No warp route found for symbol "NONEXISTENT"',
      );
    }
  });

  it('should use warpDeployConfig when promptByDeploymentConfigs is true', async () => {
    const registry = createMockRegistry();
    const context = createMockContext(false, registry);
    const result = await resolveWarpRouteId({
      context,
      warpRouteId: 'eth',
      promptByDeploymentConfigs: true,
    });

    // warpDeployConfig only has 'ETH/ethereum-arbitrum', not 'ETH/ethereum-optimism'
    expect(result).to.equal('ETH/ethereum-arbitrum');
  });

  it('should throw explicit error when symbol is not found in warpDeployConfig', async () => {
    const registry = createMockRegistry();
    const context = createMockContext(false, registry);
    try {
      await resolveWarpRouteId({
        context,
        warpRouteId: 'dai',
        promptByDeploymentConfigs: true,
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'No warp route found for symbol "DAI"',
      );
    }
  });

  describe('chain filtering', () => {
    it('should filter routes by chains and return single match', async () => {
      const context = createMockContext();
      const result = await resolveWarpRouteId({
        context,
        warpRouteId: 'eth',
        chains: ['ethereum', 'arbitrum'],
      });

      expect(result).to.equal('ETH/ethereum-arbitrum');
    });

    it('should filter routes by chains - optimism filter', async () => {
      const context = createMockContext();
      const result = await resolveWarpRouteId({
        context,
        warpRouteId: 'eth',
        chains: ['optimism'],
      });

      expect(result).to.equal('ETH/ethereum-optimism');
    });

    it('should throw explicit error when no routes match chains filter', async () => {
      const context = createMockContext();
      try {
        await resolveWarpRouteId({
          context,
          warpRouteId: 'eth',
          chains: ['polygon'],
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).to.include(
          'No warp route found for symbol "ETH" spanning chains: polygon',
        );
        expect((error as Error).message).to.include(
          'Try without --chains to see all available routes',
        );
      }
    });

    it('should not filter when chains is empty array', async () => {
      const context = createMockContext(true);
      try {
        await resolveWarpRouteId({
          context,
          warpRouteId: 'eth',
          chains: [],
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).to.include(
          'Multiple warp routes found for symbol "ETH"',
        );
      }
    });

    it('should return route matching all specified chains', async () => {
      const context = createMockContext();
      const result = await resolveWarpRouteId({
        context,
        warpRouteId: 'usdc',
        chains: ['ethereum', 'arbitrum', 'optimism'],
      });

      expect(result).to.equal('USDC/circle');
    });
  });
});

describe('getWarpCoreConfigOrExit', () => {
  const mockWarpCoreConfigs: Record<string, WarpCoreConfig> = {
    'ETH/ethereum-arbitrum': {
      tokens: [
        { chainName: 'ethereum', addressOrDenom: '0x1' },
        { chainName: 'arbitrum', addressOrDenom: '0x2' },
      ],
    } as WarpCoreConfig,
    'ETH/ethereum-optimism': {
      tokens: [
        { chainName: 'ethereum', addressOrDenom: '0x3' },
        { chainName: 'optimism', addressOrDenom: '0x4' },
      ],
    } as WarpCoreConfig,
  };

  const createMockRegistry = (): IRegistry =>
    ({
      listRegistryContent: async () => ({
        deployments: {
          warpRoutes: {
            'ETH/ethereum-arbitrum': {},
            'ETH/ethereum-optimism': {},
          },
          warpDeployConfig: {},
        },
      }),
      getWarpRoutes: async ({ symbol }: { symbol?: string }) => {
        if (!symbol) return mockWarpCoreConfigs;
        const upperSymbol = symbol.toUpperCase();
        return Object.fromEntries(
          Object.entries(mockWarpCoreConfigs).filter(([id]) =>
            id.startsWith(`${upperSymbol}/`),
          ),
        );
      },
      getWarpRoute: async (routeId: string) => {
        return mockWarpCoreConfigs[routeId] || null;
      },
    }) as unknown as IRegistry;

  const createMockContext = (
    skipConfirmation: boolean = false,
  ): CommandContext =>
    ({
      registry: createMockRegistry(),
      skipConfirmation,
    }) as unknown as CommandContext;

  it('should resolve and return config using chain filtering', async () => {
    const context = createMockContext();
    const config = await getWarpCoreConfigOrExit({
      context,
      warpRouteId: 'eth',
      chains: ['ethereum', 'arbitrum'],
    });

    expect(config).to.deep.equal(mockWarpCoreConfigs['ETH/ethereum-arbitrum']);
  });

  it('should resolve to different route with different chains', async () => {
    const context = createMockContext();
    const config = await getWarpCoreConfigOrExit({
      context,
      warpRouteId: 'eth',
      chains: ['optimism'],
    });

    expect(config).to.deep.equal(mockWarpCoreConfigs['ETH/ethereum-optimism']);
  });

  it('should throw when no route matches chains', async () => {
    const context = createMockContext();
    try {
      await getWarpCoreConfigOrExit({
        context,
        warpRouteId: 'eth',
        chains: ['polygon'],
      });
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect((error as Error).message).to.include(
        'No warp route found for symbol "ETH" spanning chains: polygon',
      );
    }
  });
});
