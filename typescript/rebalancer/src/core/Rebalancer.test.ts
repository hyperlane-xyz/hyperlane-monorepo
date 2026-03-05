import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';
import { parseEther } from 'viem';

import { HyperlaneCore } from '@hyperlane-xyz/sdk';

import {
  buildTestMovableCollateralRoute,
  createRebalancerTestContext,
} from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';

import { Rebalancer } from './Rebalancer.js';

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

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

describe('Rebalancer', () => {
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('rebalance()', () => {
    it('should return empty array for empty routes', async () => {
      const ctx = createRebalancerTestContext();
      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const results = await rebalancer.rebalance([]);

      expect(results).to.deep.equal([]);
    });

    it('should return success result for single valid route', async () => {
      const ctx = createRebalancerTestContext();

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
    });

    it('should return failure results for routes that fail preparation', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isRebalancer: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should handle mixed success and failure results', async () => {
      const ctx = createRebalancerTestContext(
        ['ethereum', 'arbitrum', 'optimism'],
        {
          ethereum: { isRebalancer: true },
          optimism: { isRebalancer: false },
        },
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        {
          ...ctx.chainMetadata,
          optimism: {
            ...ctx.chainMetadata.ethereum,
            name: 'optimism',
            domainId: 10,
          } as any,
        },
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      const successResults = results.filter((r) => r.success);
      const failureResults = results.filter((r) => !r.success);
      expect(successResults).to.have.lengthOf(1);
      expect(failureResults).to.have.lengthOf(1);
    });
  });

  describe('validateRoute()', () => {
    it('should fail when origin token not found', async () => {
      const ctx = createRebalancerTestContext(['arbitrum']);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('null');
    });

    it('should fail when destination token not found', async () => {
      const ctx = createRebalancerTestContext(['ethereum']);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should fail when signer is not a rebalancer', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isRebalancer: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should fail when destination is not in allowed list', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          allowedDestination: '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should fail when bridge is not allowed', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isBridgeAllowed: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });
  });

  describe('prepareTransactions()', () => {
    it('should create failure result when quote fetching throws', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { throwOnQuotes: new Error('Quote fetch failed') },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should create failure result when tx population throws', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { throwOnPopulate: new Error('Populate failed') },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });
  });

  describe('executeTransactions()', () => {
    it('should create failure result when gas estimation fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.estimateGas = Sinon.stub().rejects(
        new Error('Gas estimation failed'),
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Gas estimation failed');
    });

    it('should continue with other routes when one fails gas estimation', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let callCount = 0;
      ctx.multiProvider.estimateGas = Sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Gas estimation failed'));
        }
        return Promise.resolve(100000n);
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        {
          ...ctx.chainMetadata,
          optimism: {
            ...ctx.chainMetadata.ethereum,
            name: 'optimism',
            domainId: 10,
          } as any,
        },
        { ...ctx.tokensByChainName, optimism: ctx.tokensByChainName.ethereum },
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      const failures = results.filter((r) => !r.success);
      const successes = results.filter((r) => r.success);
      expect(failures).to.have.lengthOf(1);
      expect(successes).to.have.lengthOf(1);
    });

    it('should group transactions by origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let sendCallCount = 0;
      (ctx.multiProvider.sendTransaction as Sinon.SinonStub).callsFake(() => {
        sendCallCount++;
        return Promise.resolve({
          transactionHash: `0x${sendCallCount.toString().padStart(64, '0')}`,
          blockNumber: 100,
          status: 1,
        });
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'optimism',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      await rebalancer.rebalance(routes);

      expect(sendCallCount).to.equal(3);
    });
  });

  describe('sendTransactionsForChain()', () => {
    it('should return error result when send fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.sendTransaction = Sinon.stub().rejects(
        new Error('Send failed'),
      );

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Send failed');
    });

    it('should continue sending remaining transactions after one fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      let callCount = 0;
      ctx.multiProvider.sendTransaction = Sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('First send failed'));
        }
        return Promise.resolve({
          transactionHash:
            '0xTxHash2222222222222222222222222222222222222222222222222222222222',
          blockNumber: 100,
          status: 1,
        });
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          amount: parseEther('100'),
        }),
        buildTestMovableCollateralRoute({
          amount: parseEther('200'),
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      expect(results.filter((r) => !r.success)).to.have.lengthOf(1);
      expect(results.filter((r) => r.success)).to.have.lengthOf(1);
    });

    it('should send transactions sequentially within same origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      const callOrder: string[] = [];
      ctx.multiProvider.sendTransaction = Sinon.stub().callsFake(
        async (chain: string) => {
          callOrder.push(chain);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            transactionHash: `0x${callOrder.length.toString().padStart(64, '0')}`,
            blockNumber: 100,
            status: 1,
          };
        },
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: parseEther('100'),
        }),
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'optimism',
          amount: parseEther('200'),
        }),
      ];

      await rebalancer.rebalance(routes);

      expect(callOrder).to.deep.equal(['ethereum', 'ethereum']);
    });
  });

  describe('result building', () => {
    it('should include messageId when dispatch message found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedMessageId =
        '0xMessageId111111111111111111111111111111111111111111111111111111';
      sandbox
        .stub(HyperlaneCore, 'getDispatchedMessages')
        .returns([{ id: expectedMessageId } as any]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(results[0].messageId).to.equal(expectedMessageId);
    });

    it('should return success: false when no Dispatch event found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('no Dispatch event found');
      expect(results[0].messageId).to.equal('');
    });

    it('should include txHash in result', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedTxHash =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x2222222222222222222222222222222222222222222222222222222222222222',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].txHash).to.equal(expectedTxHash);
    });
  });
});
