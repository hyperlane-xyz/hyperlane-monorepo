import { expect } from 'vitest';
import { ethers } from 'ethers';
import { pino } from 'pino';

import { HyperlaneCore } from '@hyperlane-xyz/sdk';

import {
  buildTestMovableCollateralRoute,
  createRebalancerTestContext,
} from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';

import { Rebalancer } from './Rebalancer.js';

function createMockActionTracker(): IActionTracker {
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

const testLogger = pino({ level: 'silent' });

describe('Rebalancer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

      expect(results).toEqual([]);
    });

    it('should return success result for single valid route', async () => {
      const ctx = createRebalancerTestContext();

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it('should handle mixed success and failure results', async () => {
      const ctx = createRebalancerTestContext(
        ['ethereum', 'arbitrum', 'optimism'],
        {
          ethereum: { isRebalancer: true },
          optimism: { isRebalancer: false },
        },
      );

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(results).toHaveLength(2);
      const successResults = results.filter((r) => r.success);
      const failureResults = results.filter((r) => !r.success);
      expect(successResults).toHaveLength(1);
      expect(failureResults).toHaveLength(1);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('null');
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it('should log scaled route amounts using origin local units', async () => {
      const ctx = createRebalancerTestContext(['ethereum']);
      ctx.tokensByChainName.ethereum.scale = {
        numerator: 1,
        denominator: 1_000_000_000_000,
      };

      const logger = {
        child: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      logger.child.mockReturnValue(logger);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        logger as any,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 1_000_000n,
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      const validationErrorCall = logger.error.mock.calls.find(
        (call) =>
          call[1] === 'Route validation failed: destination token not found.',
      );
      expect(validationErrorCall).not.toBeUndefined();
      expect(validationErrorCall![0].amount).toBe(1);
      expect(validationErrorCall![1]).toBe(
        'Route validation failed: destination token not found.',
      );
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it('should denormalize canonical route amounts before quote and populate calls', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.tokensByChainName.ethereum.scale = {
        numerator: 1,
        denominator: 1_000_000_000_000,
      };

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      await rebalancer.rebalance([
        buildTestMovableCollateralRoute({
          amount: 1_000_000n,
        }),
      ]);

      expect(ctx.adapters.ethereum.getRebalanceQuotes.calledOnce).toBe(true);
      expect(ctx.adapters.ethereum.getRebalanceQuotes.firstCall.args[3]).toBe(
        1_000_000_000_000_000_000n,
      );
      expect(ctx.adapters.ethereum.populateRebalanceTx.firstCall.args[1]).toBe(
        1_000_000_000_000_000_000n,
      );
    });
  });

  describe('executeTransactions()', () => {
    it('should create failure result when gas estimation fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.estimateGas = vi
        .fn()
        .mockRejectedValue(new Error('Gas estimation failed'));

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Gas estimation failed');
    });

    it('should continue with other routes when one fails gas estimation', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let callCount = 0;
      ctx.multiProvider.estimateGas = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Gas estimation failed'));
        }
        return Promise.resolve(ethers.BigNumber.from(100000));
      });

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(results).toHaveLength(2);
      const failures = results.filter((r) => !r.success);
      const successes = results.filter((r) => r.success);
      expect(failures).toHaveLength(1);
      expect(successes).toHaveLength(1);
    });

    it('should group transactions by origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let sendCallCount = 0;
      ctx.multiProvider.sendTransaction = vi.fn().mockImplementation(() => {
        sendCallCount++;
        return Promise.resolve({
          transactionHash: `0x${sendCallCount.toString().padStart(64, '0')}`,
          blockNumber: 100,
          status: 1,
        });
      });

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(sendCallCount).toBe(3);
    });
  });

  describe('sendTransactionsForChain()', () => {
    it('should return error result when send fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.sendTransaction = vi
        .fn()
        .mockRejectedValue(new Error('Send failed'));

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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Send failed');
    });

    it('should continue sending remaining transactions after one fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      let callCount = 0;
      ctx.multiProvider.sendTransaction = vi.fn().mockImplementation(() => {
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

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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
          amount: ethers.utils.parseEther('100').toBigInt(),
        }),
        buildTestMovableCollateralRoute({
          amount: ethers.utils.parseEther('200').toBigInt(),
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).toHaveLength(2);
      expect(results.filter((r) => !r.success)).toHaveLength(1);
      expect(results.filter((r) => r.success)).toHaveLength(1);
    });

    it('should send transactions sequentially within same origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      const callOrder: string[] = [];
      ctx.multiProvider.sendTransaction = vi
        .fn()
        .mockImplementation(async (chain: string) => {
          callOrder.push(chain);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            transactionHash: `0x${callOrder.length.toString().padStart(64, '0')}`,
            blockNumber: 100,
            status: 1,
          };
        });

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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
          amount: ethers.utils.parseEther('100').toBigInt(),
        }),
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'optimism',
          amount: ethers.utils.parseEther('200').toBigInt(),
        }),
      ];

      await rebalancer.rebalance(routes);

      expect(callOrder).toEqual(['ethereum', 'ethereum']);
    });
  });

  describe('result building', () => {
    it('should include messageId when dispatch message found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedMessageId =
        '0xMessageId111111111111111111111111111111111111111111111111111111';
      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
        { id: expectedMessageId } as any,
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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].messageId).toBe(expectedMessageId);
    });

    it('should return success: false when no Dispatch event found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([]);

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

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('no Dispatch event found');
      expect(results[0].messageId).toBe('');
    });

    it('should include txHash in result', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedTxHash =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      vi.spyOn(HyperlaneCore, 'getDispatchedMessages').mockReturnValue([
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

      expect(results).toHaveLength(1);
      expect(results[0].txHash).toBe(expectedTxHash);
    });
  });
});
