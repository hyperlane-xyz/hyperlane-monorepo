import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import { ExecutionType, RebalancerStrategyOptions } from '../config/types.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type { IInventoryRebalancer } from '../interfaces/IInventoryRebalancer.js';
import { MonitorEventType } from '../interfaces/IMonitor.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { TEST_ADDRESSES, getTestAddress } from '../test/helpers.js';
import type { IActionTracker } from '../tracking/index.js';
import { InflightContextAdapter } from '../tracking/index.js';

import {
  RebalancerOrchestrator,
  type RebalancerOrchestratorDeps,
} from './RebalancerOrchestrator.js';

chai.use(chaiAsPromised);

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
  } as RebalancerConfig;
}

function createMockMultiProvider(): MultiProvider {
  return {
    getDomainId: Sinon.stub().callsFake((chain: string) => {
      const domains: Record<string, number> = { ethereum: 1, arbitrum: 42161 };
      return domains[chain] ?? 0;
    }),
    getSigner: Sinon.stub().returns({
      getAddress: Sinon.stub().resolves(TEST_ADDRESSES.signer),
    }),
    metadata: {
      ethereum: { domainId: 1 },
      arbitrum: { domainId: 42161 },
    },
  } as unknown as MultiProvider;
}

function createMockRebalancer(): IRebalancer & { rebalance: Sinon.SinonStub } {
  return {
    rebalance: Sinon.stub().resolves([]),
  };
}

function createMockStrategy(): IStrategy & {
  getRebalancingRoutes: Sinon.SinonStub;
} {
  return {
    name: 'mock-strategy',
    getRebalancingRoutes: Sinon.stub().returns([]),
  };
}

function createMockActionTracker(): IActionTracker {
  return {
    initialize: Sinon.stub().resolves(),
    createRebalanceIntent: Sinon.stub().callsFake(async () => ({
      id: `intent-${Date.now()}`,
      status: 'not_started',
    })),
    createRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceAction: Sinon.stub().resolves(),
    failRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceIntent: Sinon.stub().resolves(),
    cancelRebalanceIntent: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
    syncTransfers: Sinon.stub().resolves(),
    syncRebalanceIntents: Sinon.stub().resolves(),
    syncRebalanceActions: Sinon.stub().resolves(),
    syncInventoryMovementActions: Sinon.stub().resolves({
      completed: 0,
      failed: 0,
    }),
    logStoreContents: Sinon.stub().resolves(),
    getInProgressTransfers: Sinon.stub().resolves([]),
    getActiveRebalanceIntents: Sinon.stub().resolves([]),
    getTransfersByDestination: Sinon.stub().resolves([]),
    getRebalanceIntentsByDestination: Sinon.stub().resolves([]),
    getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
    getActionsByType: Sinon.stub().resolves([]),
    getActionsForIntent: Sinon.stub().resolves([]),
    getInflightInventoryMovements: Sinon.stub().resolves(0n),
  };
}

function createMockInflightContextAdapter(): InflightContextAdapter & {
  getInflightContext: Sinon.SinonStub;
} {
  return {
    getInflightContext: Sinon.stub().resolves({
      pendingRebalances: [],
      pendingTransfers: [],
    }),
  } as unknown as InflightContextAdapter & {
    getInflightContext: Sinon.SinonStub;
  };
}

function createMockInventoryRebalancer(): IInventoryRebalancer & {
  execute: Sinon.SinonStub;
} {
  return {
    execute: Sinon.stub().resolves([]),
    getAvailableAmount: Sinon.stub().resolves(0n),
  };
}

function createMockInventoryMonitor(): IInventoryMonitor {
  return {
    getBalances: Sinon.stub().resolves(new Map()),
    getAvailableInventory: Sinon.stub().resolves(0n),
    refresh: Sinon.stub().resolves(),
    getTotalInventory: Sinon.stub().resolves(0n),
  };
}

function createMockBridge(): IExternalBridge {
  return {
    bridgeId: 'lifi',
    quote: Sinon.stub().resolves({}),
    execute: Sinon.stub().resolves({}),
    getStatus: Sinon.stub().resolves({}),
  } as unknown as IExternalBridge;
}

function createMockMetrics(): Metrics {
  return {
    recordRebalancerSuccess: Sinon.stub(),
    recordRebalancerFailure: Sinon.stub(),
    recordIntentCreated: Sinon.stub(),
    processToken: Sinon.stub().resolves(),
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
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('executeCycle() - No Routes', () => {
    it('should complete cycle when no routes proposed', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(0);
      expect(result.executedCount).to.equal(0);
      expect(result.failedCount).to.equal(0);
      expect(strategy.getRebalancingRoutes.calledOnce).to.be.true;
    });

    it('should sync action tracker even when no routes', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect((actionTracker.syncTransfers as Sinon.SinonStub).calledOnce).to.be
        .true;
      expect((actionTracker.syncRebalanceIntents as Sinon.SinonStub).calledOnce)
        .to.be.true;
      expect((actionTracker.syncRebalanceActions as Sinon.SinonStub).calledOnce)
        .to.be.true;
    });
  });

  describe('executeCycle() - Movable Collateral Routes Only', () => {
    it('should execute movable collateral routes successfully', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            intentId: 'intent-1',
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
      (actionTracker.createRebalanceIntent as Sinon.SinonStub).resolves({
        id: 'intent-1',
        status: 'not_started',
      });

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancer,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(1);
      expect(result.executedCount).to.equal(1);
      expect(result.failedCount).to.equal(0);
      expect(rebalancer.rebalance.calledOnce).to.be.true;
      expect(
        (actionTracker.createRebalanceAction as Sinon.SinonStub).calledOnce,
      ).to.be.true;
    });

    it('should handle failed movable collateral routes', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            intentId: 'intent-1',
            bridge: TEST_ADDRESSES.bridge,
          },
          success: false,
          error: 'Gas estimation failed',
        },
      ]);

      const actionTracker = createMockActionTracker();
      (actionTracker.createRebalanceIntent as Sinon.SinonStub).resolves({
        id: 'intent-1',
        status: 'not_started',
      });

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancer,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(1);
      expect(result.executedCount).to.equal(0);
      expect(result.failedCount).to.equal(1);
      expect((actionTracker.failRebalanceIntent as Sinon.SinonStub).calledOnce)
        .to.be.true;
      expect(
        (actionTracker.failRebalanceIntent as Sinon.SinonStub).calledWith(
          'intent-1',
        ),
      ).to.be.true;
    });
  });

  describe('executeCycle() - Inventory Routes Only', () => {
    it('should execute inventory routes successfully', async () => {
      // Config with inventory chain
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
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.execute.resolves([
        {
          success: true,
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
          },
          intent: {
            id: 'intent-1',
            status: 'in_progress',
          },
        },
      ]);

      const inventoryMonitor = createMockInventoryMonitor();
      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        inventoryRebalancer,
        inventoryMonitor,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(1);
      expect(inventoryRebalancer.execute.calledOnce).to.be.true;
      expect((inventoryMonitor.refresh as Sinon.SinonStub).calledTwice).to.be
        .true; // Once before strategy, once before execution
    });
  });

  describe('executeCycle() - Mixed Routes', () => {
    it('should execute both movable collateral and inventory routes', async () => {
      // Config with mixed execution types
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
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'optimism',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
        {
          origin: 'arbitrum',
          destination: 'ethereum',
          amount: 500n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: {
            origin: 'ethereum',
            destination: 'optimism',
            amount: 1000n,
            intentId: 'intent-1',
            bridge: TEST_ADDRESSES.bridge,
          },
          success: true,
          messageId: '0x1111',
          txHash: '0x2222',
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.execute.resolves([
        {
          success: true,
          route: {
            origin: 'arbitrum',
            destination: 'ethereum',
            amount: 500n,
          },
          intent: {
            id: 'intent-2',
            status: 'in_progress',
          },
        },
      ]);

      const inventoryMonitor = createMockInventoryMonitor();
      const actionTracker = createMockActionTracker();
      (actionTracker.createRebalanceIntent as Sinon.SinonStub).resolves({
        id: 'intent-1',
        status: 'not_started',
      });

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancer,
        inventoryRebalancer,
        inventoryMonitor,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(2);
      expect(result.executedCount).to.equal(1); // Only movable collateral counts
      expect(result.failedCount).to.equal(0);
      expect(rebalancer.rebalance.calledOnce).to.be.true;
      expect(inventoryRebalancer.execute.calledOnce).to.be.true;
    });
  });

  describe('executeCycle() - Continue Inventory Intents', () => {
    it('should call inventoryRebalancer.execute([]) when no routes proposed', async () => {
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
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]); // No routes proposed

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.execute.resolves([]);

      const inventoryMonitor = createMockInventoryMonitor();
      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        inventoryRebalancer,
        inventoryMonitor,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      // CRITICAL: Verify inventoryRebalancer.execute was called with empty array
      expect(inventoryRebalancer.execute.calledOnce).to.be.true;
      expect(inventoryRebalancer.execute.calledWith([])).to.be.true;
    });

    it('should NOT call inventoryRebalancer.execute([]) when routes are proposed', async () => {
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
      } as RebalancerConfig;

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const inventoryRebalancer = createMockInventoryRebalancer();
      inventoryRebalancer.execute.resolves([
        {
          success: true,
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
          },
          intent: {
            id: 'intent-1',
            status: 'in_progress',
          },
        },
      ]);

      const inventoryMonitor = createMockInventoryMonitor();
      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        inventoryRebalancer,
        inventoryMonitor,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: config,
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      // Verify inventoryRebalancer.execute was called ONCE with the route (not twice)
      expect(inventoryRebalancer.execute.calledOnce).to.be.true;
      expect(inventoryRebalancer.execute.calledWith([])).to.be.false;
    });

    it('should NOT call inventoryRebalancer.execute([]) when inventoryRebalancer is undefined', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        // No inventoryRebalancer
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      // Should not throw
      await orchestrator.executeCycle(event);
    });
  });

  describe('syncActionTracker() Error Handling', () => {
    it('should warn but continue when syncTransfers fails', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      (actionTracker.syncTransfers as Sinon.SinonStub).rejects(
        new Error('Sync failed'),
      );

      const inflightAdapter = createMockInflightContextAdapter();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      // Should not throw
      const result = await orchestrator.executeCycle(event);

      expect(result.proposedRoutes).to.have.lengthOf(0);
      expect(strategy.getRebalancingRoutes.calledOnce).to.be.true;
    });

    it('should sync inventory movement actions when bridge is provided', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();
      const bridge = createMockBridge();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        bridge,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect(
        (actionTracker.syncInventoryMovementActions as Sinon.SinonStub)
          .calledOnce,
      ).to.be.true;
      expect(
        (
          actionTracker.syncInventoryMovementActions as Sinon.SinonStub
        ).calledWith(bridge),
      ).to.be.true;
    });
  });

  describe('Metrics Recording', () => {
    it('should record success metric when all routes succeed', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            intentId: 'intent-1',
            bridge: TEST_ADDRESSES.bridge,
          },
          success: true,
          messageId: '0x1111',
          txHash: '0x2222',
        },
      ]);

      const actionTracker = createMockActionTracker();
      (actionTracker.createRebalanceIntent as Sinon.SinonStub).resolves({
        id: 'intent-1',
        status: 'not_started',
      });

      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancer,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect((metrics.recordRebalancerSuccess as Sinon.SinonStub).calledOnce).to
        .be.true;
      expect((metrics.recordRebalancerFailure as Sinon.SinonStub).called).to.be
        .false;
    });

    it('should record failure metric when any route fails', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            intentId: 'intent-1',
            bridge: TEST_ADDRESSES.bridge,
          },
          success: false,
          error: 'Gas estimation failed',
        },
      ]);

      const actionTracker = createMockActionTracker();
      (actionTracker.createRebalanceIntent as Sinon.SinonStub).resolves({
        id: 'intent-1',
        status: 'not_started',
      });

      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        rebalancer,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect((metrics.recordRebalancerFailure as Sinon.SinonStub).calledOnce).to
        .be.true;
      expect((metrics.recordRebalancerSuccess as Sinon.SinonStub).called).to.be
        .false;
    });

    it('should process token metrics when metrics is provided', async () => {
      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();
      const metrics = createMockMetrics();

      const deps: RebalancerOrchestratorDeps = {
        strategy,
        actionTracker,
        inflightContextAdapter: inflightAdapter,
        multiProvider: createMockMultiProvider(),
        rebalancerConfig: createMockRebalancerConfig(),
        logger: testLogger,
        metrics,
      };

      const orchestrator = new RebalancerOrchestrator(deps);
      const event = createMonitorEvent();

      await orchestrator.executeCycle(event);

      expect((metrics.processToken as Sinon.SinonStub).calledTwice).to.be.true;
    });
  });
});
