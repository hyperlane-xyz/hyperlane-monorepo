import { expect } from 'chai';
import Sinon from 'sinon';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { IActionTracker } from './IActionTracker.js';
import { InflightContextAdapter } from './InflightContextAdapter.js';
import type { RebalanceIntent, Transfer } from './types.js';

describe('InflightContextAdapter', () => {
  let actionTracker: Sinon.SinonStubbedInstance<IActionTracker>;
  let multiProvider: Sinon.SinonStubbedInstance<MultiProvider>;
  let adapter: InflightContextAdapter;

  beforeEach(() => {
    actionTracker = {
      getActiveRebalanceIntents: Sinon.stub(),
      getInProgressTransfers: Sinon.stub(),
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
          fulfilledAmount: 0n,
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
      multiProvider.getChainName.withArgs(1).returns('ethereum');
      multiProvider.getChainName.withArgs(2).returns('arbitrum');

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).to.have.lengthOf(1);
      expect(result.pendingRebalances[0]).to.deep.equal({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 1000n,
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
          fulfilledAmount: 0n,
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
          fulfilledAmount: 0n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'intent2',
          origin: 2,
          destination: 3,
          amount: 1500n,
          fulfilledAmount: 0n,
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
      multiProvider.getChainName.withArgs(1).returns('ethereum');
      multiProvider.getChainName.withArgs(2).returns('arbitrum');
      multiProvider.getChainName.withArgs(3).returns('optimism');

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).to.have.lengthOf(2);
      expect(result.pendingTransfers).to.have.lengthOf(2);
    });
  });
});
