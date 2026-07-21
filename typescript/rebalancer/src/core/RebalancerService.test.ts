import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import { type IRegistry, RegistryType } from '@hyperlane-xyz/registry';
import type { MultiProvider, Token, WarpCore } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
} from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import { MonitorEventType } from '../interfaces/IMonitor.js';
import type {
  IInventoryRebalancer,
  IRebalancer,
} from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { type InventoryMonitorConfig, Monitor } from '../monitor/Monitor.js';
import { TEST_ADDRESSES, getTestAddress } from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';
import type {
  RebalanceAction,
  RebalanceIntent,
  RebalanceIntentStatus,
} from '../tracking/types.js';

import {
  type ManualRebalanceRequest,
  RebalancerService,
  type RebalancerServiceConfig,
} from './RebalancerService.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

function createMockRegistry(): IRegistry {
  return {
    type: RegistryType.Partial,
    uri: 'mock://registry',
    getUri: Sinon.stub().returns('mock://registry'),
    listRegistryContent: Sinon.stub().resolves({
      chains: {},
      deployments: { warpRoutes: {}, warpDeployConfig: {} },
    }),
    getChains: Sinon.stub().resolves([]),
    getMetadata: Sinon.stub().resolves({}),
    getChainMetadata: Sinon.stub().resolves(null),
    getAddresses: Sinon.stub().resolves({}),
    getChainAddresses: Sinon.stub().resolves(null),
    getChainLogoUri: Sinon.stub().resolves(null),
    addChain: Sinon.stub().resolves(),
    updateChain: Sinon.stub().resolves(),
    removeChain: Sinon.stub().resolves(),
    getWarpRoute: Sinon.stub().resolves(null),
    getWarpRoutes: Sinon.stub().resolves({}),
    addWarpRoute: Sinon.stub().resolves(),
    addWarpRouteConfig: Sinon.stub().resolves(),
    getWarpDeployConfig: Sinon.stub().resolves({}),
    getWarpDeployConfigs: Sinon.stub().resolves({}),
    merge: Sinon.stub().returnsThis(),
  };
}

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

function createMockToken(chainName: string): Token {
  return {
    chainName,
    name: `${chainName}Token`,
    decimals: 18,
    addressOrDenom: getTestAddress(chainName),
    standard: 'EvmHypCollateral',
    protocol: ProtocolType.Ethereum,
    isCollateralized: () => true,
    getAdapter: Sinon.stub().returns({
      getBalance: Sinon.stub().resolves(MANUAL_INVENTORY_AMOUNT),
    }),
  } as unknown as Token;
}

function createMockWarpCore(
  chainNames: string[] = ['ethereum', 'arbitrum'],
): WarpCore {
  return {
    tokens: chainNames.map(createMockToken),
    multiProvider: createMockMultiProvider(),
  } as unknown as WarpCore;
}

function createMockRebalancer(): IRebalancer & { rebalance: Sinon.SinonStub } {
  return {
    rebalancerType: 'movableCollateral' as const,
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

interface MockActionTracker extends IActionTracker {
  cancelRebalanceIntent: Sinon.SinonStub;
  getActionsForIntent: Sinon.SinonStub;
  getActiveRebalanceIntents: Sinon.SinonStub;
  getPartiallyFulfilledInventoryIntents: Sinon.SinonStub;
  getRebalanceIntent: Sinon.SinonStub;
  logStoreContents: Sinon.SinonStub;
  syncInventoryMovementActions: Sinon.SinonStub;
  syncRebalanceActions: Sinon.SinonStub;
  syncRebalanceIntents: Sinon.SinonStub;
}

function createMockActionTracker(): MockActionTracker {
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
    getTransfer: Sinon.stub().resolves(undefined),
    getRebalanceIntent: Sinon.stub().resolves(undefined),
    getRebalanceAction: Sinon.stub().resolves(undefined),
    getInProgressActions: Sinon.stub().resolves([]),
    getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
    getActionsByType: Sinon.stub().resolves([]),
    getActionsForIntent: Sinon.stub().resolves([]),
    getInflightInventoryMovements: Sinon.stub().resolves(0n),
  };
}

interface MockInventoryRebalancer extends IInventoryRebalancer {
  rebalance: Sinon.SinonStub;
  setInventoryBalances: Sinon.SinonStub;
}

function createMockInventoryRebalancer(): MockInventoryRebalancer {
  return {
    rebalancerType: 'inventory',
    rebalance: Sinon.stub().resolves([]),
    setInventoryBalances: Sinon.stub(),
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

function createMockContextFactory(
  overrides: {
    warpCore?: WarpCore;
    rebalancer?: IRebalancer;
    strategy?: IStrategy;
    actionTracker?: IActionTracker;
    inflightAdapter?: InflightContextAdapter;
    monitor?: Monitor;
    metrics?: Metrics;
    inventoryRebalancer?: MockInventoryRebalancer;
    inventoryConfig?: InventoryMonitorConfig;
    createRebalancers?: Sinon.SinonStub;
    createManualInventoryContext?: Sinon.SinonStub;
  } = {},
): RebalancerContextFactory {
  const warpCore = overrides.warpCore ?? createMockWarpCore();
  const rebalancer = overrides.rebalancer ?? createMockRebalancer();
  const strategy = overrides.strategy ?? createMockStrategy();
  const actionTracker = overrides.actionTracker ?? createMockActionTracker();
  const inflightAdapter =
    overrides.inflightAdapter ?? createMockInflightContextAdapter();
  const monitor =
    overrides.monitor ??
    ({
      on: Sinon.stub().returnsThis(),
      start: Sinon.stub().resolves(),
      stop: Sinon.stub().resolves(),
    } as unknown as Monitor);
  const rebalancers: IRebalancer[] = [rebalancer];
  if (overrides.inventoryRebalancer) {
    rebalancers.push(overrides.inventoryRebalancer);
  }
  const inventoryConfig = overrides.inventoryRebalancer
    ? (overrides.inventoryConfig ?? {
        inventoryAddresses: {
          [ProtocolType.Ethereum]: TEST_ADDRESSES.signer,
        },
        chains: warpCore.tokens.map((token) => token.chainName),
      })
    : undefined;
  const createRebalancers =
    overrides.createRebalancers ??
    Sinon.stub().resolves({
      rebalancers,
      externalBridgeRegistry: {},
      inventoryConfig,
    });
  const createManualInventoryContext =
    overrides.createManualInventoryContext ??
    Sinon.stub().resolves({
      actionTracker,
      externalBridgeRegistry: { [ExternalBridgeType.LiFi]: {} },
      inventoryConfig,
      inventoryRebalancer: overrides.inventoryRebalancer,
      warpCore,
    });

  return {
    getWarpCore: () => warpCore,
    getTokenForChain: (chain: string) =>
      warpCore.tokens.find((t) => t.chainName === chain),
    createRebalancer: (_actionTracker: IActionTracker) => rebalancer,
    createRebalancers,
    createStrategy: async () => strategy,
    createMonitor: () => monitor,
    createMetrics: async () => overrides.metrics ?? ({} as Metrics),
    createActionTracker: async () => ({
      tracker: actionTracker,
      adapter: inflightAdapter,
    }),
    createManualInventoryContext,
    createOrchestrator: (options: {
      strategy: IStrategy;
      actionTracker: IActionTracker;
      inflightContextAdapter: InflightContextAdapter;
      rebalancers: IRebalancer[];
      externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
      metrics?: Metrics;
    }) => ({
      executeCycle: Sinon.stub().callsFake(async (_event: any) => {
        // Simulate orchestrator behavior: call strategy, then rebalancer, then record metrics
        const strategyWithGetRoutes = options.strategy as any;
        const routes = strategyWithGetRoutes.getRebalancingRoutes?.() ?? [];
        if (routes.length > 0 && options.rebalancers[0]) {
          const results = await options.rebalancers[0].rebalance(routes);
          if (options.metrics && results) {
            results.forEach((result: any) => {
              if (result.success) {
                (options.metrics as any).recordRebalancerSuccess?.();
              } else {
                (options.metrics as any).recordRebalancerFailure?.();
              }
            });
          }
        }
        return { success: true };
      }),
    }),
  } as unknown as RebalancerContextFactory;
}

const MANUAL_INVENTORY_AMOUNT = 100_000_000_000_000_000_000n;
const MANUAL_INTENT_ID = 'manual-inventory-intent';

function createManualIntent(
  status: RebalanceIntentStatus,
  amount = MANUAL_INVENTORY_AMOUNT,
  executionMethod: RebalanceIntent['executionMethod'] = 'inventory',
): RebalanceIntent {
  const now = Date.now();
  return {
    id: MANUAL_INTENT_ID,
    status,
    origin: 1,
    destination: 42161,
    amount,
    executionMethod,
    createdAt: now,
    updatedAt: now,
  };
}

function createCompletedDeposit(amount: bigint): RebalanceAction {
  const now = Date.now();
  return {
    id: 'manual-inventory-deposit',
    status: 'complete',
    type: 'inventory_deposit',
    intentId: MANUAL_INTENT_ID,
    origin: 1,
    destination: 42161,
    amount,
    createdAt: now,
    updatedAt: now,
  };
}

interface ManualInventoryTestSetup {
  actionTracker: MockActionTracker;
  contextFactoryCreate: Sinon.SinonStub;
  createManualInventoryContext: Sinon.SinonStub;
  inventoryRebalancer: MockInventoryRebalancer;
  logger: typeof testLogger;
  movableRebalancer: ReturnType<typeof createMockRebalancer>;
  service: RebalancerService;
}

function setupManualInventoryTest(
  sandbox: Sinon.SinonSandbox,
  options: {
    config?: RebalancerConfig;
    origin?: string;
    destination?: string;
  } = {},
): ManualInventoryTestSetup {
  const origin = options.origin ?? 'ethereum';
  const destination = options.destination ?? 'arbitrum';
  const warpCore = createMockWarpCore([origin, destination]);
  const movableRebalancer = createMockRebalancer();
  const inventoryRebalancer = createMockInventoryRebalancer();
  const actionTracker = createMockActionTracker();
  const logger = pino({ level: 'silent' });
  const completedIntent = createManualIntent('complete');
  actionTracker.getRebalanceIntent.resolves(completedIntent);
  actionTracker.getActionsForIntent.resolves([
    createCompletedDeposit(MANUAL_INVENTORY_AMOUNT),
  ]);
  inventoryRebalancer.rebalance.resolves([
    {
      route: {
        origin,
        destination,
        amount: MANUAL_INVENTORY_AMOUNT,
        executionType: 'inventory',
        externalBridge: ExternalBridgeType.LiFi,
      },
      success: true,
      intentId: MANUAL_INTENT_ID,
    },
  ]);

  const createManualInventoryContext = Sinon.stub().resolves({
    actionTracker,
    externalBridgeRegistry: { [ExternalBridgeType.LiFi]: {} },
    inventoryConfig: {
      inventoryAddresses: {
        [ProtocolType.Ethereum]: TEST_ADDRESSES.signer,
      },
      chains: [origin, destination],
    },
    inventoryRebalancer,
    warpCore,
  });
  const contextFactory = createMockContextFactory({
    warpCore,
    rebalancer: movableRebalancer,
    inventoryRebalancer,
    actionTracker,
    createManualInventoryContext,
  });
  const contextFactoryCreate = sandbox
    .stub(RebalancerContextFactory, 'create')
    .resolves(contextFactory);
  const service = new RebalancerService(
    createMockMultiProvider(),
    undefined,
    createMockRegistry(),
    options.config ?? createMockRebalancerConfig(),
    { mode: 'manual', logger },
  );

  return {
    actionTracker,
    contextFactoryCreate,
    createManualInventoryContext,
    inventoryRebalancer,
    logger,
    movableRebalancer,
    service,
  };
}

function createManualInventoryRequest(
  overrides: Partial<ManualRebalanceRequest> = {},
): ManualRebalanceRequest {
  return {
    origin: 'ethereum',
    destination: 'arbitrum',
    amount: '100',
    executionType: ExecutionType.Inventory,
    externalBridge: ExternalBridgeType.LiFi,
    timeoutMs: 50,
    ...overrides,
  };
}

interface DaemonTestSetup {
  actionTracker: IActionTracker;
  rebalancer: IRebalancer & { rebalance: Sinon.SinonStub };
  strategy: IStrategy & { getRebalancingRoutes: Sinon.SinonStub };
  triggerCycle: () => Promise<void>;
}

async function setupDaemonTest(
  sandbox: Sinon.SinonSandbox,
  options: {
    rebalanceResults: Array<{
      route: {
        origin: string;
        destination: string;
        amount: bigint;
        bridge: string;
      };
      success: boolean;
      messageId?: string;
      txHash?: string;
      error?: string;
    }>;
    strategyRoutes: Array<{
      origin: string;
      destination: string;
      amount: bigint;
      bridge: string;
    }>;
  },
): Promise<DaemonTestSetup> {
  const actionTracker = createMockActionTracker();

  const rebalancer = createMockRebalancer();
  rebalancer.rebalance.resolves(options.rebalanceResults);

  const strategy = createMockStrategy();
  strategy.getRebalancingRoutes.returns(options.strategyRoutes);

  const inflightAdapter = createMockInflightContextAdapter();

  let tokenInfoHandler: ((event: any) => Promise<void>) | undefined;
  const monitor = {
    on: Sinon.stub().callsFake((event: string, handler: any) => {
      if (event === MonitorEventType.TokenInfo) {
        tokenInfoHandler = handler;
      }
      return monitor;
    }),
    start: Sinon.stub().resolves(),
    stop: Sinon.stub().resolves(),
  } as unknown as Monitor;

  const contextFactory = createMockContextFactory({
    rebalancer,
    strategy,
    actionTracker,
    inflightAdapter,
    monitor,
  });
  sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

  const service = new RebalancerService(
    createMockMultiProvider(),
    undefined,
    {} as any,
    createMockRebalancerConfig(),
    { mode: 'daemon', checkFrequency: 60000, logger: testLogger },
  );

  await service.start();

  return {
    actionTracker,
    rebalancer,
    strategy,
    triggerCycle: async () => {
      expect(tokenInfoHandler).to.not.be.undefined;
      await tokenInfoHandler!({
        tokensInfo: [
          { token: createMockToken('ethereum'), bridgedSupply: 5000n },
          { token: createMockToken('arbitrum'), bridgedSupply: 5000n },
        ],
      });
    },
  };
}

describe('RebalancerService', () => {
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('executeManual()', () => {
    it('should execute manual rebalance successfully', async () => {
      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.resolves([
        {
          route: { origin: 'ethereum', destination: 'arbitrum', amount: 1000n },
          success: true,
          messageId:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
          txHash:
            '0x2222222222222222222222222222222222222222222222222222222222222222',
        },
      ]);

      const contextFactory = createMockContextFactory({ rebalancer });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.executeManual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: '100',
      });

      expect(rebalancer.rebalance.calledOnce).to.be.true;
      const calledRoutes = rebalancer.rebalance.firstCall.args[0];
      expect(calledRoutes).to.have.lengthOf(1);
      expect(calledRoutes[0].origin).to.equal('ethereum');
      expect(calledRoutes[0].destination).to.equal('arbitrum');
      expect(calledRoutes[0].executionType).to.equal('movableCollateral');
    });

    it('should normalize manual amount to canonical units when token has scale', async () => {
      const rebalancer = createMockRebalancer();
      const warpCore = {
        tokens: [
          {
            ...createMockToken('ethereum'),
            decimals: 18,
            scale: { numerator: 1n, denominator: 1_000_000_000_000n },
          },
          createMockToken('arbitrum'),
        ],
        multiProvider: createMockMultiProvider(),
      } as unknown as WarpCore;

      const contextFactory = createMockContextFactory({ rebalancer, warpCore });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        { mode: 'manual', logger: testLogger },
      );

      await service.executeManual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: '1',
      });

      const calledRoutes = rebalancer.rebalance.firstCall.args[0];
      expect(calledRoutes[0].amount).to.equal(1_000_000n);
    });

    it('should throw when origin token not found', async () => {
      const warpCore = {
        tokens: [createMockToken('arbitrum')],
        multiProvider: createMockMultiProvider(),
      } as unknown as WarpCore;

      const contextFactory = createMockContextFactory({ warpCore });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '100',
        }),
      ).to.be.rejectedWith('Origin token not found');
    });

    it('should throw when amount is invalid', async () => {
      const contextFactory = createMockContextFactory();
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 'invalid',
        }),
      ).to.be.rejectedWith('Amount must be a valid number');
    });

    it('should throw when amount is zero or negative', async () => {
      const contextFactory = createMockContextFactory();
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '0',
        }),
      ).to.be.rejectedWith('Amount must be greater than 0');

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '-100',
        }),
      ).to.be.rejectedWith('Amount must be greater than 0');
    });

    it('should throw when origin chain has no bridge configured', async () => {
      const contextFactory = createMockContextFactory();
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const configWithoutBridge: RebalancerConfig = {
        warpRouteId: 'TEST/route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              arbitrum: {
                bridge: TEST_ADDRESSES.bridge,
                bridgeMinAcceptedAmount: 0,
                weighted: { weight: 100n, tolerance: 10n },
              },
            },
          },
        ],
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        configWithoutBridge,
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '100',
        }),
      ).to.be.rejectedWith('No bridge configured for origin chain ethereum');
    });

    it('should throw when in monitorOnly mode', async () => {
      const contextFactory = createMockContextFactory();
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        monitorOnly: true,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '100',
        }),
      ).to.be.rejectedWith('MonitorOnly mode cannot execute manual rebalances');
    });

    it('should propagate errors from rebalancer', async () => {
      const rebalancer = createMockRebalancer();
      rebalancer.rebalance.rejects(new Error('Rebalance failed'));

      const contextFactory = createMockContextFactory({ rebalancer });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(
        service.executeManual({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: '100',
        }),
      ).to.be.rejectedWith('Rebalance failed');
    });

    it('dispatches inventory routes only to the inventory rebalancer', async () => {
      const setup = setupManualInventoryTest(sandbox);

      await setup.service.executeManual(createManualInventoryRequest());

      expect(setup.inventoryRebalancer.rebalance.calledOnce).to.be.true;
      expect(setup.movableRebalancer.rebalance.called).to.be.false;
      const routes = setup.inventoryRebalancer.rebalance.firstCall.args[0];
      expect(routes).to.deep.equal([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: MANUAL_INVENTORY_AMOUNT,
          executionType: 'inventory',
          externalBridge: ExternalBridgeType.LiFi,
        },
      ]);
    });

    it('prefers the request external bridge over strategy configuration', async () => {
      const config = createMockRebalancerConfig();
      config.strategyConfig[0].chains.ethereum.externalBridge =
        ExternalBridgeType.LiFi;
      config.strategyConfig[0].chains.ethereum.override = {
        arbitrum: { externalBridge: ExternalBridgeType.LiFi },
      };
      const setup = setupManualInventoryTest(sandbox, { config });

      await setup.service.executeManual(
        createManualInventoryRequest({
          externalBridge: ExternalBridgeType.SwapsXyz,
        }),
      );

      const route = setup.inventoryRebalancer.rebalance.firstCall.args[0][0];
      expect(route.externalBridge).to.equal(ExternalBridgeType.SwapsXyz);
    });

    it('uses the destination override external bridge when request omits it', async () => {
      const config = createMockRebalancerConfig();
      config.strategyConfig[0].chains.ethereum.externalBridge =
        ExternalBridgeType.SwapsXyz;
      config.strategyConfig[0].chains.ethereum.override = {
        arbitrum: { externalBridge: ExternalBridgeType.LiFi },
      };
      const setup = setupManualInventoryTest(sandbox, { config });

      await setup.service.executeManual(
        createManualInventoryRequest({ externalBridge: undefined }),
      );

      const route = setup.inventoryRebalancer.rebalance.firstCall.args[0][0];
      expect(route.externalBridge).to.equal(ExternalBridgeType.LiFi);
    });

    it('uses the origin external bridge when no override is configured', async () => {
      const config = createMockRebalancerConfig();
      config.strategyConfig[0].chains.ethereum.externalBridge =
        ExternalBridgeType.SwapsXyz;
      const setup = setupManualInventoryTest(sandbox, { config });

      await setup.service.executeManual(
        createManualInventoryRequest({ externalBridge: undefined }),
      );

      const route = setup.inventoryRebalancer.rebalance.firstCall.args[0][0];
      expect(route.externalBridge).to.equal(ExternalBridgeType.SwapsXyz);
    });

    it('throws when no manual inventory external bridge is available', async () => {
      const setup = setupManualInventoryTest(sandbox);

      await expect(
        setup.service.executeManual(
          createManualInventoryRequest({ externalBridge: undefined }),
        ),
      ).to.be.rejectedWith('No external bridge configured');
      expect(setup.contextFactoryCreate.called).to.be.false;
    });

    it('supports off-config inventory legs through the manual context', async () => {
      const origin = 'optimism';
      const destination = 'base';
      const setup = setupManualInventoryTest(sandbox, { origin, destination });

      await setup.service.executeManual(
        createManualInventoryRequest({ origin, destination }),
      );

      expect(setup.createManualInventoryContext.firstCall.args[0]).to.include({
        origin,
        destination,
        externalBridge: ExternalBridgeType.LiFi,
      });
      const route = setup.inventoryRebalancer.rebalance.firstCall.args[0][0];
      expect(route.origin).to.equal(origin);
      expect(route.destination).to.equal(destination);
    });

    it('resolves when a complete intent has fully completed deposits', async () => {
      const setup = setupManualInventoryTest(sandbox);

      await setup.service.executeManual(createManualInventoryRequest());

      expect(setup.actionTracker.getActionsForIntent.calledOnce).to.be.true;
      expect(
        setup.actionTracker.getActionsForIntent.firstCall.args[0],
      ).to.equal(MANUAL_INTENT_ID);
    });

    it('rejects a complete intent without completed deposits', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.actionTracker.getActionsForIntent.resolves([]);

      await expect(
        setup.service.executeManual(createManualInventoryRequest()),
      ).to.be.rejectedWith('completed without moving funds');
    });

    it('accepts partial completed deposits and warns about the remainder', async () => {
      const setup = setupManualInventoryTest(sandbox);
      const warning = sandbox.spy(setup.logger, 'warn');
      setup.actionTracker.getActionsForIntent.resolves([
        createCompletedDeposit(MANUAL_INVENTORY_AMOUNT / 2n),
      ]);

      await setup.service.executeManual(createManualInventoryRequest());

      expect(
        warning.calledWithMatch(
          Sinon.match.has(
            'writtenOffAmount',
            (MANUAL_INVENTORY_AMOUNT / 2n).toString(),
          ),
          'Manual inventory rebalance completed with a written-off remainder',
        ),
      ).to.be.true;
    });

    for (const status of [
      'failed',
      'cancelled',
    ] satisfies RebalanceIntentStatus[]) {
      it(`rejects an intent with ${status} status`, async () => {
        const setup = setupManualInventoryTest(sandbox);
        setup.actionTracker.getRebalanceIntent.resolves(
          createManualIntent(status),
        );

        await expect(
          setup.service.executeManual(createManualInventoryRequest()),
        ).to.be.rejectedWith(`reached terminal status ${status}`);
      });
    }

    it('logs stores and rejects when the intent never becomes terminal', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.actionTracker.getRebalanceIntent.resolves(
        createManualIntent('in_progress'),
      );

      await expect(
        setup.service.executeManual(
          createManualInventoryRequest({ timeoutMs: 10 }),
        ),
      ).to.be.rejectedWith('Manual inventory rebalance timed out');
      expect(setup.actionTracker.logStoreContents.calledOnce).to.be.true;
    });

    it('cancels the intent when the first dispatch fails', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.inventoryRebalancer.rebalance.resolves([
        {
          route: createManualInventoryRequest(),
          success: false,
          intentId: MANUAL_INTENT_ID,
          error: 'dispatch failed',
        },
      ]);

      await expect(
        setup.service.executeManual(createManualInventoryRequest()),
      ).to.be.rejectedWith('dispatch failed');
      expect(
        setup.actionTracker.cancelRebalanceIntent.calledOnceWith(
          MANUAL_INTENT_ID,
        ),
      ).to.be.true;
    });

    it('rejects a partially fulfilled inventory intent before dispatch', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.actionTracker.getPartiallyFulfilledInventoryIntents.resolves([
        {
          intent: createManualIntent('in_progress'),
          completedAmount: 0n,
          remaining: MANUAL_INVENTORY_AMOUNT,
          hasInflightDeposit: false,
        },
      ]);

      await expect(
        setup.service.executeManual(createManualInventoryRequest()),
      ).to.be.rejectedWith(`intent ${MANUAL_INTENT_ID} is active`);
      expect(setup.inventoryRebalancer.rebalance.called).to.be.false;
    });

    it('rejects an active inventory intent omitted by the partial query', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.actionTracker.getActiveRebalanceIntents.resolves([
        createManualIntent('in_progress'),
      ]);

      await expect(
        setup.service.executeManual(createManualInventoryRequest()),
      ).to.be.rejectedWith(`intent ${MANUAL_INTENT_ID} is active`);
      expect(setup.inventoryRebalancer.rebalance.called).to.be.false;
    });

    it('ignores active intents using another execution method', async () => {
      const setup = setupManualInventoryTest(sandbox);
      setup.actionTracker.getActiveRebalanceIntents.resolves([
        createManualIntent(
          'in_progress',
          MANUAL_INVENTORY_AMOUNT,
          'movable_collateral',
        ),
      ]);

      await setup.service.executeManual(createManualInventoryRequest());

      expect(setup.inventoryRebalancer.rebalance.calledOnce).to.be.true;
    });

    it('supports a second attended manual run', async () => {
      const setup = setupManualInventoryTest(sandbox);
      await setup.service.executeManual(createManualInventoryRequest());
      await setup.service.executeManual(createManualInventoryRequest());

      expect(setup.inventoryRebalancer.rebalance.callCount).to.equal(2);
      expect(setup.createManualInventoryContext.callCount).to.equal(2);
    });
  });

  describe('start()', () => {
    it('should throw when not in daemon mode', async () => {
      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await expect(service.start()).to.be.rejectedWith(
        'start() can only be called in daemon mode',
      );
    });

    it('should start monitor in daemon mode', async () => {
      const monitor = {
        on: Sinon.stub().returnsThis(),
        start: Sinon.stub().resolves(),
        stop: Sinon.stub().resolves(),
      } as unknown as Monitor;

      const contextFactory = createMockContextFactory({ monitor });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: 60000,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.start();

      expect((monitor.on as Sinon.SinonStub).called).to.be.true;
      expect((monitor.start as Sinon.SinonStub).calledOnce).to.be.true;
    });
  });

  describe('stop()', () => {
    it('should stop monitor', async () => {
      const monitor = {
        on: Sinon.stub().returnsThis(),
        start: Sinon.stub().resolves(),
        stop: Sinon.stub().resolves(),
      } as unknown as Monitor;

      const contextFactory = createMockContextFactory({ monitor });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: 60000,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.start();
      await service.stop();

      expect((monitor.stop as Sinon.SinonStub).calledOnce).to.be.true;
    });
  });

  describe('daemon mode metrics', () => {
    it('should record failure metric when rebalance has failed results', async () => {
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

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const recordRebalancerSuccess = Sinon.stub();
      const recordRebalancerFailure = Sinon.stub();
      const metrics = {
        recordRebalancerSuccess,
        recordRebalancerFailure,
        recordIntentCreated: Sinon.stub(),
        processToken: Sinon.stub().resolves(),
      } as unknown as Metrics;

      let tokenInfoHandler: ((event: any) => Promise<void>) | undefined;
      const monitor = {
        on: Sinon.stub().callsFake((event: string, handler: any) => {
          if (event === MonitorEventType.TokenInfo) {
            tokenInfoHandler = handler;
          }
          return monitor;
        }),
        start: Sinon.stub().resolves(),
        stop: Sinon.stub().resolves(),
      } as unknown as Monitor;

      const contextFactory = createMockContextFactory({
        rebalancer,
        strategy,
        actionTracker,
        inflightAdapter,
        monitor,
        metrics,
      });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: 60000,
        withMetrics: true,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.start();

      expect(tokenInfoHandler).to.not.be.undefined;
      await tokenInfoHandler!({
        tokensInfo: [
          { token: createMockToken('ethereum'), bridgedSupply: 5000n },
          { token: createMockToken('arbitrum'), bridgedSupply: 5000n },
        ],
      });

      expect(recordRebalancerFailure.calledOnce).to.be.true;
      expect(recordRebalancerSuccess.called).to.be.false;
    });

    it('should record success metric when all rebalance results succeed', async () => {
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

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 1000n,
          bridge: TEST_ADDRESSES.bridge,
        },
      ]);

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const recordRebalancerSuccess = Sinon.stub();
      const recordRebalancerFailure = Sinon.stub();
      const metrics = {
        recordRebalancerSuccess,
        recordRebalancerFailure,
        recordIntentCreated: Sinon.stub(),
        processToken: Sinon.stub().resolves(),
      } as unknown as Metrics;

      let tokenInfoHandler: ((event: any) => Promise<void>) | undefined;
      const monitor = {
        on: Sinon.stub().callsFake((event: string, handler: any) => {
          if (event === MonitorEventType.TokenInfo) {
            tokenInfoHandler = handler;
          }
          return monitor;
        }),
        start: Sinon.stub().resolves(),
        stop: Sinon.stub().resolves(),
      } as unknown as Monitor;

      const contextFactory = createMockContextFactory({
        rebalancer,
        strategy,
        actionTracker,
        inflightAdapter,
        monitor,
        metrics,
      });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: 60000,
        withMetrics: true,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.start();

      expect(tokenInfoHandler).to.not.be.undefined;
      await tokenInfoHandler!({
        tokensInfo: [
          { token: createMockToken('ethereum'), bridgedSupply: 5000n },
          { token: createMockToken('arbitrum'), bridgedSupply: 5000n },
        ],
      });

      expect(recordRebalancerSuccess.calledOnce).to.be.true;
      expect(recordRebalancerFailure.called).to.be.false;
    });

    it('should record failure metric when rebalance has mixed results', async () => {
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
        {
          route: {
            origin: 'arbitrum',
            destination: 'ethereum',
            amount: 500n,
            intentId: 'intent-2',
            bridge: TEST_ADDRESSES.bridge,
          },
          success: false,
          error: 'Insufficient balance',
        },
      ]);

      const strategy = createMockStrategy();
      strategy.getRebalancingRoutes.returns([
        {
          origin: 'ethereum',
          destination: 'arbitrum',
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

      const actionTracker = createMockActionTracker();
      const inflightAdapter = createMockInflightContextAdapter();

      const recordRebalancerSuccess = Sinon.stub();
      const recordRebalancerFailure = Sinon.stub();
      const metrics = {
        recordRebalancerSuccess,
        recordRebalancerFailure,
        recordIntentCreated: Sinon.stub(),
        processToken: Sinon.stub().resolves(),
      } as unknown as Metrics;

      let tokenInfoHandler: ((event: any) => Promise<void>) | undefined;
      const monitor = {
        on: Sinon.stub().callsFake((event: string, handler: any) => {
          if (event === MonitorEventType.TokenInfo) {
            tokenInfoHandler = handler;
          }
          return monitor;
        }),
        start: Sinon.stub().resolves(),
        stop: Sinon.stub().resolves(),
      } as unknown as Monitor;

      const contextFactory = createMockContextFactory({
        rebalancer,
        strategy,
        actionTracker,
        inflightAdapter,
        monitor,
        metrics,
      });
      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: 60000,
        withMetrics: true,
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.start();

      expect(tokenInfoHandler).to.not.be.undefined;
      await tokenInfoHandler!({
        tokensInfo: [
          { token: createMockToken('ethereum'), bridgedSupply: 5000n },
          { token: createMockToken('arbitrum'), bridgedSupply: 5000n },
        ],
      });

      expect(recordRebalancerFailure.calledOnce).to.be.true;
      expect(recordRebalancerSuccess.calledOnce).to.be.true;
    });
  });

  describe('daemon mode rebalancer calls', () => {
    it('should call rebalancer with routes from strategy', async () => {
      const { rebalancer, triggerCycle } = await setupDaemonTest(sandbox, {
        rebalanceResults: [
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
          },
        ],
        strategyRoutes: [
          {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
        ],
      });

      await triggerCycle();

      expect(rebalancer.rebalance.calledOnce).to.be.true;
      const routesPassedToRebalancer = rebalancer.rebalance.firstCall.args[0];
      expect(routesPassedToRebalancer).to.have.lengthOf(1);
      expect(routesPassedToRebalancer[0].origin).to.equal('ethereum');
      expect(routesPassedToRebalancer[0].destination).to.equal('arbitrum');
    });

    it('should call rebalancer with multiple routes', async () => {
      const { rebalancer, triggerCycle } = await setupDaemonTest(sandbox, {
        rebalanceResults: [
          {
            route: {
              origin: 'ethereum',
              destination: 'arbitrum',
              amount: 1000n,
              bridge: TEST_ADDRESSES.bridge,
            },
            success: true,
          },
          {
            route: {
              origin: 'arbitrum',
              destination: 'ethereum',
              amount: 500n,
              bridge: TEST_ADDRESSES.bridge,
            },
            success: true,
          },
        ],
        strategyRoutes: [
          {
            origin: 'ethereum',
            destination: 'arbitrum',
            amount: 1000n,
            bridge: TEST_ADDRESSES.bridge,
          },
          {
            origin: 'arbitrum',
            destination: 'ethereum',
            amount: 500n,
            bridge: TEST_ADDRESSES.bridge,
          },
        ],
      });

      await triggerCycle();

      expect(rebalancer.rebalance.calledOnce).to.be.true;
      const routesPassedToRebalancer = rebalancer.rebalance.firstCall.args[0];
      expect(routesPassedToRebalancer).to.have.lengthOf(2);
    });

    it('should not call rebalancer when no routes proposed', async () => {
      const { rebalancer, triggerCycle } = await setupDaemonTest(sandbox, {
        rebalanceResults: [],
        strategyRoutes: [],
      });

      await triggerCycle();

      expect(rebalancer.rebalance.called).to.be.false;
    });
  });

  describe('initialization', () => {
    it('should initialize only once', async () => {
      const contextFactory = createMockContextFactory();
      const createStub = sandbox
        .stub(RebalancerContextFactory, 'create')
        .resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.executeManual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: '100',
      });

      await service.executeManual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: '200',
      });

      expect(createStub.calledOnce).to.be.true;
    });

    it('should create metrics when withMetrics is enabled', async () => {
      const metrics = {} as Metrics;
      const contextFactory = createMockContextFactory({ metrics });
      const createMetricsSpy = Sinon.spy(contextFactory, 'createMetrics');

      sandbox.stub(RebalancerContextFactory, 'create').resolves(contextFactory);

      const config: RebalancerServiceConfig = {
        mode: 'manual',
        withMetrics: true,
        coingeckoApiKey: 'test-key',
        logger: testLogger,
      };

      const service = new RebalancerService(
        createMockMultiProvider(),
        undefined,
        {} as any,
        createMockRebalancerConfig(),
        config,
      );

      await service.executeManual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: '100',
      });

      expect(createMetricsSpy.calledOnce).to.be.true;
      expect(createMetricsSpy.firstCall.args[0]).to.equal('test-key');
    });
  });
});
