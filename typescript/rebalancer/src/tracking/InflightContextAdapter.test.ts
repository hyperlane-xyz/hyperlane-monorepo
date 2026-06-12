import { expect } from 'chai';
import Sinon from 'sinon';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { IActionTracker } from './IActionTracker.js';
import { InflightContextAdapter } from './InflightContextAdapter.js';
import type { RebalanceAction, RebalanceIntent, Transfer } from './types.js';

describe('InflightContextAdapter', () => {
  let actionTracker: Sinon.SinonStubbedInstance<IActionTracker>;
  let multiProvider: Sinon.SinonStubbedInstance<MultiProvider>;
  let adapter: InflightContextAdapter;

  beforeEach(() => {
    actionTracker = {
      getActiveRebalanceIntents: Sinon.stub(),
      getInProgressTransfers: Sinon.stub(),
      getActionsForIntent: Sinon.stub(),
      getActionsForIntents: Sinon.stub(),
    } as any;

    multiProvider = {
      getChainName: Sinon.stub(),
    } as any;

    adapter = new InflightContextAdapter(
      actionTracker as any,
      multiProvider as any,
    );
  });

  afterEach(() => {
    Sinon.restore();
  });

  describe('getInflightContext', () => {
    it('should return both pendingRebalances and pendingTransfers', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 1,
          destination: 2,
          amount: 1000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 1,
          destination: 2,
          amount: 500n,
          messageId: '0x123',
          sender: '0xabc' as any,
          recipient: '0xdef' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      actionTracker.getActiveRebalanceIntents.resolves(mockIntents);
      actionTracker.getInProgressTransfers.resolves(mockTransfers);
      actionTracker.getActionsForIntent.resolves([]); // No actions
      multiProvider.getChainName.withArgs(1).returns('ethereum');
      multiProvider.getChainName.withArgs(2).returns('arbitrum');

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).to.have.lengthOf(1);
      expect(result.pendingRebalances[0]).to.deep.equal({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 1000n,
        deliveredAmount: 0n,
        awaitingDeliveryAmount: 0n,
        executionMethod: undefined,
        bridge: undefined,
      });

      expect(result.pendingTransfers).to.have.lengthOf(1);
      expect(result.pendingTransfers[0]).to.deep.equal({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 500n,
      });
    });

    it('should handle empty arrays', async () => {
      actionTracker.getActiveRebalanceIntents.resolves([]);
      actionTracker.getInProgressTransfers.resolves([]);

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).to.be.an('array').that.is.empty;
      expect(result.pendingTransfers).to.be.an('array').that.is.empty;
    });

    it('should correctly convert domain IDs to chain names', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 137,
          destination: 10,
          amount: 2000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 137,
          destination: 10,
          amount: 300n,
          messageId: '0x456',
          sender: '0x111' as any,
          recipient: '0x222' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      actionTracker.getActiveRebalanceIntents.resolves(mockIntents);
      actionTracker.getInProgressTransfers.resolves(mockTransfers);
      actionTracker.getActionsForIntent.resolves([]);
      multiProvider.getChainName.withArgs(137).returns('polygon');
      multiProvider.getChainName.withArgs(10).returns('optimism');

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances[0].origin).to.equal('polygon');
      expect(result.pendingRebalances[0].destination).to.equal('optimism');
      expect(result.pendingTransfers[0].origin).to.equal('polygon');
      expect(result.pendingTransfers[0].destination).to.equal('optimism');
    });

    it('should handle multiple intents and transfers', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 1,
          destination: 2,
          amount: 1000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'intent2',
          origin: 2,
          destination: 3,
          amount: 1500n,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 1,
          destination: 2,
          amount: 500n,
          messageId: '0x123',
          sender: '0xabc' as any,
          recipient: '0xdef' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'transfer2',
          origin: 3,
          destination: 1,
          amount: 750n,
          messageId: '0x789',
          sender: '0x333' as any,
          recipient: '0x444' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      actionTracker.getActiveRebalanceIntents.resolves(mockIntents);
      actionTracker.getInProgressTransfers.resolves(mockTransfers);
      actionTracker.getActionsForIntent.resolves([]);
      multiProvider.getChainName.withArgs(1).returns('ethereum');
      multiProvider.getChainName.withArgs(2).returns('arbitrum');
      multiProvider.getChainName.withArgs(3).returns('optimism');

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).to.have.lengthOf(2);
      expect(result.pendingTransfers).to.have.lengthOf(2);
    });

    it('should fetch inventory intent actions in one batch', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'inventory-intent-1',
          origin: 1,
          destination: 2,
          amount: 1000n,
          status: 'in_progress',
          executionMethod: 'inventory',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'inventory-intent-2',
          origin: 2,
          destination: 3,
          amount: 2000n,
          status: 'in_progress',
          executionMethod: 'inventory',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const actionsByIntent = new Map<string, RebalanceAction[]>([
        [
          'inventory-intent-1',
          [
            {
              id: 'action-complete',
              type: 'inventory_deposit',
              status: 'complete',
              intentId: 'inventory-intent-1',
              origin: 1,
              destination: 2,
              amount: 300n,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            {
              id: 'action-in-progress',
              type: 'inventory_deposit',
              status: 'in_progress',
              intentId: 'inventory-intent-1',
              origin: 1,
              destination: 2,
              amount: 200n,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        ],
        ['inventory-intent-2', []],
      ]);

      actionTracker.getActiveRebalanceIntents.resolves(mockIntents);
      actionTracker.getInProgressTransfers.resolves([]);
      actionTracker.getActionsForIntents!.resolves(actionsByIntent);
      multiProvider.getChainName.withArgs(1).returns('ethereum');
      multiProvider.getChainName.withArgs(2).returns('arbitrum');
      multiProvider.getChainName.withArgs(3).returns('optimism');

      const result = await adapter.getInflightContext();

      expect(actionTracker.getActionsForIntents!.calledOnce).to.be.true;
      expect(
        actionTracker.getActionsForIntents!.firstCall.args[0],
      ).to.deep.equal(['inventory-intent-1', 'inventory-intent-2']);
      expect(actionTracker.getActionsForIntent.notCalled).to.be.true;
      expect(result.pendingRebalances[0].deliveredAmount).to.equal(300n);
      expect(result.pendingRebalances[0].awaitingDeliveryAmount).to.equal(200n);
      expect(result.pendingRebalances[1].deliveredAmount).to.equal(0n);
      expect(result.pendingRebalances[1].awaitingDeliveryAmount).to.equal(0n);
    });
  });
});
