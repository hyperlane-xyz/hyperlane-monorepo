import { pino } from 'pino';
import type { Mock, MockInstance } from 'vitest';
import { expect } from 'vitest';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExecutionType,
  RebalancerStrategyOptions,
} from '../config/types.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import { MonitorEventType } from '../interfaces/IMonitor.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { TEST_ADDRESSES, getTestAddress } from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';

import {
  RebalancerOrchestrator,
  type RebalancerOrchestratorDeps,
} from './RebalancerOrchestrator.js';

const testLogger = pino({ level: 'silent' });

function createMockRebalancerConfig(): RebalancerConfig {
  return {
    warpRouteId: 'TEST/route',
    strategyConfig: [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          ethereum: {
            bridge: TEST_ADDRESSES.bridge,
            bridgeMinAcceptedAmount: 0,
            weighted: { weight: 50n, tolerance: 10n },
          },
          arbitrum: {
            bridge: TEST_ADDRESSES.bridge,
            bridgeMinAcceptedAmount: 0,
            weighted: { weight: 50n, tolerance: 10n },
          },
        },
      },
    ],
    intentTTL: DEFAULT_INTENT_TTL_MS,
  } as RebalancerConfig;
}

function createMockRebalancer(): IRebalancer & { rebalance: MockInstance } {
  return {
    rebalancerType: 'movableCollateral' as const,
    rebalance: vi.fn().mockResolvedValue([]),
  };
}

function createMockStrategy(): IStrategy & {
  getRebalancingRoutes: MockInstance;
} {
  return {
    name: 'mock-strategy',
    getRebalancingRoutes: vi.fn().mockReturnValue([]),
  };
}

type MockActionTracker = {
  [K in keyof IActionTracker]: IActionTracker[K] extends (
    ...args: infer A
  ) => infer R
    ? Mock<(...args: A) => R>
    : IActionTracker[K];
};

function createMockActionTracker(): MockActionTracker {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createRebalanceIntent: vi.fn().mockImplementation(async () => ({
      id: `intent-${Date.now()}`,
      status: 'not_started',
    })),
    createRebalanceAction: vi.fn().mockResolvedValue(undefined),
    completeRebalanceAction: vi.fn().mockResolvedValue(undefined),
    failRebalanceAction: vi.fn().mockResolvedValue(undefined),
    completeRebalanceIntent: vi.fn().mockResolvedValue(undefined),
    cancelRebalanceIntent: vi.fn().mockResolvedValue(undefined),
    failRebalanceIntent: vi.fn().mockResolvedValue(undefined),
    syncTransfers: vi.fn().mockResolvedValue(undefined),
    syncRebalanceIntents: vi.fn().mockResolvedValue(undefined),
    syncRebalanceActions: vi.fn().mockResolvedValue(undefined),
    syncInventoryMovementActions: vi.fn().mockResolvedValue({
      completed: 0,
      failed: 0,
    }),
    logStoreContents: vi.fn().mockResolvedValue(undefined),
    getInProgressTransfers: vi.fn().mockResolvedValue([]),
    getActiveRebalanceIntents: vi.fn().mockResolvedValue([]),
    getTransfersByDestination: vi.fn().mockResolvedValue([]),
    getRebalanceIntentsByDestination: vi.fn().mockResolvedValue([]),
    getTransfer: vi.fn().mockResolvedValue(undefined),
    getRebalanceIntent: vi.fn().mockResolvedValue(undefined),
    getRebalanceAction: vi.fn().mockResolvedValue(undefined),
    getInProgressActions: vi.fn().mockResolvedValue([]),
    getPartiallyFulfilledInventoryIntents: vi.fn().mockResolvedValue([]),
    getActionsByType: vi.fn().mockResolvedValue([]),
    getActionsForIntent: vi.fn().mockResolvedValue([]),
    getInflightInventoryMovements: vi.fn().mockResolvedValue(0n),
  };
}

function createMockInflightContextAdapter(): InflightContextAdapter & {
  getInflightContext: MockInstance;
} {
  return {
    getInflightContext: vi.fn().mockResolvedValue({
      pendingRebalances: [],
      pendingTransfers: [],
    }),
  } as unknown as InflightContextAdapter & {
    getInflightContext: MockInstance;
  };
}

function createMockInventoryRebalancer(): IRebalancer & {
  rebalance: MockInstance;
  setInventoryBalances: MockInstance;
} {
  return {
    rebalancerType: 'inventory' as const,
    rebalance: vi.fn().mockResolvedValue([]),
    setInventoryBalances: vi.fn(),
  };
}

function createMockBridge(): IExternalBridge {
  return {
    bridgeId: 'lifi',
    quote: vi.fn().mockResolvedValue({}),
    execute: vi.fn().mockResolvedValue({}),
    getStatus: vi.fn().mockResolvedValue({}),
  } as unknown as IExternalBridge;
}

function createMockMetrics(): Metrics {
  return {
    recordRebalancerSuccess: vi.fn(),
    recordRebalancerFailure: vi.fn(),
    recordIntentCreated: vi.fn(),
    processToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as Metrics;
}

function createMonitorEvent(overrides?: any) {
  return {
    type: MonitorEventType.TokenInfo,
    tokensInfo: [
      {
        token: {
          chainName: 'ethereum',
          name: 'EthereumToken',
          decimals: 18,
          addressOrDenom: getTestAddress('ethereum'),
          standard: 'EvmHypCollateral',
          isCollateralized: () => true,
        },
        balance: 5000n,
        bridgedSupply: 5000n,
      },
      {
        token: {
          chainName: 'arbitrum',
          name: 'ArbitrumToken',
          decimals: 18,
          addressOrDenom: getTestAddress('arbitrum'),
          standard: 'EvmHypCollateral',
          isCollateralized: () => true,
        },
        balance: 5000n,
        bridgedSupply: 5000n,
      },
    ],
    confirmedBlockTags: {
      ethereum: 100,
      arbitrum: 200,
    },
    ...overrides,
  };
}

describe('RebalancerOrchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeCycle() - No Routes', () => {
    it('should complete cycle when no routes proposed', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(0);
      expect(result.executedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(strategy.getRebalancingRoutes).toHaveBeenCalledOnce();
    });

    it('should sync action tracker even when no routes', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(actionTracker.syncTransfers).toHaveBeenCalledOnce();
      expect(actionTracker.syncRebalanceIntents).toHaveBeenCalledOnce();
      expect(actionTracker.syncRebalanceActions).toHaveBeenCalledOnce();
    });
  });

  describe('executeCycle() - Movable Collateral Routes Only', () => {
    it('should execute movable collateral routes successfully', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
          executionType: 'movableCollateral',
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.mockResolvedValue([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          success: true,
          messageId:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
          txHash:
            '0x2222222222222222222222222222222222222222222222222222222222222222',
        },
      ]);

      const actionTracker = createMockActionTracker();

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [rebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(1);
      expect(result.executedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(rebalancer.rebalance).toHaveBeenCalledOnce();
    });

    it('should handle failed movable collateral routes', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
          executionType: 'movableCollateral',
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.mockResolvedValue([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          success: false,
          error: 'Gas estimation failed',
        },
      ]);

      const actionTracker = createMockActionTracker();

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [rebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(1);
      expect(result.executedCount).toBe(0);
      expect(result.failedCount).toBe(1);
    });
  });

  describe('executeCycle() - Inventory Routes Only', () => {
    it('should execute inventory routes successfully', async () => {
      const config: RebalancerConfig = {
        warpRouteId: 'TEST/route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              ethereum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
                executionType: ExecutionType.Inventory,
              },
              arbitrum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
              },
            },
          },
        ],
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          externalBridge: 'lifi',
          executionType: 'inventory',
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.rebalance.mockResolvedValue([
        {
          success: true,
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
          },
        },
      ]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [inventoryRebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(1);
      expect(inventoryRebalancer.rebalance).toHaveBeenCalledOnce();
    });
  });

  describe('executeCycle() - Mixed Routes', () => {
    it('should execute both movable collateral and inventory routes', async () => {
      const config: RebalancerConfig = {
        warpRouteId: 'TEST/route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              ethereum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 33n, tolerance: 10n },
              },
              arbitrum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 33n, tolerance: 10n },
                executionType: ExecutionType.Inventory,
              },
              optimism: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 34n, tolerance: 10n },
              },
            },
          },
        ],
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'optimism',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
          executionType: 'movableCollateral',
        },
        {
          origin: 'arbitrum',
          destination: 'ethereum',
          amount: 500n,
          externalBridge: 'lifi',
          executionType: 'inventory',
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.mockResolvedValue([
        {
          route: {
            origin: 'ethereum',
            destination: 'optimism',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          success: true,
          messageId: '0x1111',
          txHash: '0x2222',
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.rebalance.mockResolvedValue([
        {
          success: true,
          route: {
            origin: 'arbitrum',
            destination: 'ethereum',
            amount: 500n,
          },
        },
      ]);

      const actionTracker = createMockActionTracker();

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [rebalancer, inventoryRebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(2);
      expect(result.executedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(rebalancer.rebalance).toHaveBeenCalledOnce();
      expect(inventoryRebalancer.rebalance).toHaveBeenCalledOnce();
    });
  });

  describe('executeCycle() - Continue Inventory Intents', () => {
    it('should call inventoryRebalancer.rebalance([]) when no routes proposed', async () => {
      const config: RebalancerConfig = {
        warpRouteId: 'TEST/route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              ethereum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
                executionType: ExecutionType.Inventory,
              },
              arbitrum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
              },
            },
          },
        ],
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.rebalance.mockResolvedValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [inventoryRebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(inventoryRebalancer.rebalance).toHaveBeenCalledOnce();
      expect(inventoryRebalancer.rebalance).toHaveBeenCalledWith([]);
    });

    it('should NOT call inventoryRebalancer.rebalance([]) when routes are proposed', async () => {
      const config: RebalancerConfig = {
        warpRouteId: 'TEST/route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              ethereum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
                executionType: ExecutionType.Inventory,
              },
              arbitrum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 50n, tolerance: 10n },
              },
            },
          },
        ],
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          externalBridge: 'lifi',
          executionType: 'inventory',
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.rebalance.mockResolvedValue([
        {
          success: true,
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
          },
        },
      ]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [inventoryRebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(inventoryRebalancer.rebalance).toHaveBeenCalledOnce();
      expect(inventoryRebalancer.rebalance).not.toHaveBeenCalledWith([]);
    });

    it('should NOT call inventoryRebalancer.rebalance([]) when inventoryRebalancer is not in rebalancers', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      // Verifies executeCycle completes without error when rebalancers is empty
      await orchestrator.executeCycle(event);
    });
  });

  describe('syncActionTracker() Error Handling', () => {
    it('should warn but continue when syncTransfers fails', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      actionTracker.syncTransfers.mockRejectedValue(new Error('Sync failed'));

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).toHaveLength(0);
      expect(strategy.getRebalancingRoutes).toHaveBeenCalledOnce();
    });

    it('should sync inventory movement actions when bridge is provided', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();
      const bridge = createMockBridge();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
        externalBridgeRegistry: { lifi: bridge },
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(actionTracker.syncInventoryMovementActions).toHaveBeenCalledOnce();
      expect(actionTracker.syncInventoryMovementActions).toHaveBeenCalledWith({
        lifi: bridge,
      });
    });
  });

  describe('Metrics Recording', () => {
    it('should record success metric when all routes succeed', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
          executionType: 'movableCollateral',
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.mockResolvedValue([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          success: true,
          messageId: '0x1111',
          txHash: '0x2222',
        },
      ]);

      const actionTracker = createMockActionTracker();

      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [rebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(metrics.recordRebalancerSuccess).toHaveBeenCalledOnce();
      expect(metrics.recordRebalancerFailure).not.toHaveBeenCalled();
    });

    it('should record failure metric when any route fails', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
          executionType: 'movableCollateral',
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.mockResolvedValue([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          success: false,
          error: 'Gas estimation failed',
        },
      ]);

      const actionTracker = createMockActionTracker();

      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancers: [rebalancer],
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(metrics.recordRebalancerFailure).toHaveBeenCalledOnce();
      expect(metrics.recordRebalancerSuccess).not.toHaveBeenCalled();
    });

    it('should process token metrics when metrics is provided', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.mockReturnValue([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        rebalancers: [],
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(metrics.processToken).toHaveBeenCalledTimes(2);
    });
  });
});
