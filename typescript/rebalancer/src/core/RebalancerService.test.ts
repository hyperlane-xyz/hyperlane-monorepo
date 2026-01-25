import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { MultiProvider, Token, WarpCore } from '@hyperlane-xyz/sdk';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import { RebalancerStrategyOptions } from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { Monitor } from '../monitor/Monitor.js';
import { TEST_ADDRESSES, getTestAddress } from '../test/helpers.js';
import type { IActionTracker } from '../tracking/index.js';
import { InflightContextAdapter } from '../tracking/index.js';

import {
  RebalancerService,
  type RebalancerServiceConfig,
} from './RebalancerService.js';

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
            bridgeIsWarp: false,
            weighted: { weight: 50n, tolerance: 10n },
          },
          arbitrum: {
            bridge: TEST_ADDRESSES.bridge,
            bridgeMinAcceptedAmount: 0,
            bridgeIsWarp: false,
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

function createMockToken(chainName: string): Token {
  return {
    chainName,
    name: `${chainName}Token`,
    decimals: 18,
    addressOrDenom: getTestAddress(chainName),
  } as unknown as Token;
}

function createMockWarpCore(): WarpCore {
  return {
    tokens: [createMockToken('ethereum'), createMockToken('arbitrum')],
    multiProvider: createMockMultiProvider(),
  } as unknown as WarpCore;
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
    getRebalancingRoutes: Sinon.stub().returns([]),
  };
}

function createMockActionTracker(): IActionTracker & {
  initialize: Sinon.SinonStub;
  createRebalanceIntent: Sinon.SinonStub;
  createRebalanceAction: Sinon.SinonStub;
  failRebalanceIntent: Sinon.SinonStub;
  syncTransfers: Sinon.SinonStub;
  syncRebalanceIntents: Sinon.SinonStub;
  syncRebalanceActions: Sinon.SinonStub;
  logStoreContents: Sinon.SinonStub;
} {
  return {
    initialize: Sinon.stub().resolves(),
    createRebalanceIntent: Sinon.stub().callsFake(async () => ({
      id: `intent-${Date.now()}`,
      status: 'not_started',
    })),
    createRebalanceAction: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
    syncTransfers: Sinon.stub().resolves(),
    syncRebalanceIntents: Sinon.stub().resolves(),
    syncRebalanceActions: Sinon.stub().resolves(),
    logStoreContents: Sinon.stub().resolves(),
    getInProgressTransfers: Sinon.stub().returns([]),
    getActiveRebalanceIntents: Sinon.stub().returns([]),
  } as IActionTracker & {
    initialize: Sinon.SinonStub;
    createRebalanceIntent: Sinon.SinonStub;
    createRebalanceAction: Sinon.SinonStub;
    failRebalanceIntent: Sinon.SinonStub;
    syncTransfers: Sinon.SinonStub;
    syncRebalanceIntents: Sinon.SinonStub;
    syncRebalanceActions: Sinon.SinonStub;
    logStoreContents: Sinon.SinonStub;
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

  return {
    getWarpCore: () => warpCore,
    getTokenForChain: (chain: string) =>
      warpCore.tokens.find((t) => t.chainName === chain),
    createRebalancer: () => rebalancer,
    createStrategy: async () => strategy,
    createMonitor: () => monitor,
    createMetrics: async () => overrides.metrics ?? ({} as Metrics),
    createActionTracker: async () => ({
      tracker: actionTracker,
      adapter: inflightAdapter,
    }),
  } as unknown as RebalancerContextFactory;
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
