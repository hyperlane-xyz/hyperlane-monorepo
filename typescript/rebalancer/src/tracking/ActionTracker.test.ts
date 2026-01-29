import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import { EthJsonRpcBlockParameterTag } from '@hyperlane-xyz/sdk';

import type { ConfirmedBlockTags } from '../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../utils/ExplorerClient.js';

import { ActionTracker, type ActionTrackerConfig } from './ActionTracker.js';
import { InMemoryStore } from './store/InMemoryStore.js';
import type { RebalanceAction, RebalanceIntent, Transfer } from './types.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

describe('ActionTracker', () => {
  let transferStore: InMemoryStore<Transfer, 'in_progress' | 'complete'>;
  let rebalanceIntentStore: InMemoryStore<
    RebalanceIntent,
    'not_started' | 'in_progress' | 'complete' | 'cancelled'
  >;
  let rebalanceActionStore: InMemoryStore<
    RebalanceAction,
    'in_progress' | 'complete' | 'failed'
  >;
  let explorerClient: any;
  let core: any;
  let config: ActionTrackerConfig;
  let tracker: ActionTracker;
  let mailboxStub: any;

  beforeEach(() => {
    transferStore = new InMemoryStore();
    rebalanceIntentStore = new InMemoryStore();
    rebalanceActionStore = new InMemoryStore();

    // Create stub for ExplorerClient methods with default return values
    const explorerGetInflightUserTransfers = Sinon.stub().resolves([]);
    const explorerGetInflightRebalanceActions = Sinon.stub().resolves([]);

    explorerClient = {
      getInflightUserTransfers: explorerGetInflightUserTransfers,
      getInflightRebalanceActions: explorerGetInflightRebalanceActions,
    } as any;

    // Create stub for mailbox
    mailboxStub = {
      delivered: Sinon.stub().resolves(false),
    };

    // Create stub for HyperlaneCore
    const coreGetContracts = Sinon.stub().returns({ mailbox: mailboxStub });
    const multiProviderGetChainName = Sinon.stub().callsFake(
      (domain: number) => `chain${domain}`,
    );

    core = {
      getContracts: coreGetContracts,
      multiProvider: {
        getChainName: multiProviderGetChainName,
      },
    } as any;

    config = {
      routersByDomain: {
        1: '0xrouter1',
        2: '0xrouter2',
        3: '0xrouter3',
      },
      bridges: ['0xbridge1', '0xbridge2'],
      rebalancerAddress: '0xrebalancer',
    };

    tracker = new ActionTracker(
      transferStore,
      rebalanceIntentStore,
      rebalanceActionStore,
      explorerClient as any,
      core as any,
      config,
      testLogger,
    );
  });

  describe('initialize', () => {
    it('should query for inflight rebalance messages and create synthetic entities', async () => {
      const inflightMessages: ExplorerMessage[] = [
        {
          msg_id: '0xmsg1',
          origin_domain_id: 1,
          destination_domain_id: 2,
          sender: '0xrouter1',
          recipient: '0xrouter2',
          origin_tx_hash: '0xtx1',
          origin_tx_sender: '0xrebalancer',
          origin_tx_recipient: '0xrouter1',
          is_delivered: false,
          message_body:
            '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064',
        },
      ];

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);

      // Ensure mailbox returns false so action stays in_progress
      mailboxStub.delivered.resolves(false);

      await tracker.initialize();

      // Verify ExplorerClient was called twice:
      // 1. During startup recovery in initialize()
      // 2. During syncRebalanceActions() called from initialize()
      expect(explorerClient.getInflightRebalanceActions.callCount).to.equal(2);

      // Verify synthetic intent and action were created
      const intents = await rebalanceIntentStore.getAll();
      expect(intents).to.have.lengthOf(1);
      expect(intents[0].status).to.equal('in_progress');
      expect(intents[0].amount).to.equal(100n);

      const actions = await rebalanceActionStore.getAll();
      expect(actions).to.have.lengthOf(1);
      expect(actions[0].id).to.equal('0xmsg1');
      expect(actions[0].status).to.equal('in_progress');
      expect(actions[0].messageId).to.equal('0xmsg1');
    });

    it('should skip creating action if it already exists', async () => {
      const inflightMessages: ExplorerMessage[] = [
        {
          msg_id: '0xmsg1',
          origin_domain_id: 1,
          destination_domain_id: 2,
          sender: '0xrouter1',
          recipient: '0xrouter2',
          origin_tx_hash: '0xtx1',
          origin_tx_sender: '0xrebalancer',
          origin_tx_recipient: '0xrouter1',
          is_delivered: false,
          message_body:
            '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064',
        },
      ];

      // Pre-create action
      await rebalanceActionStore.save({
        id: '0xmsg1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'existing-intent',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);

      await tracker.initialize();

      // Verify no additional action was created
      const actions = await rebalanceActionStore.getAll();
      expect(actions).to.have.lengthOf(1);

      // Verify no intent was created either
      const intents = await rebalanceIntentStore.getAll();
      expect(intents).to.have.lengthOf(0);
    });
  });

  describe('syncTransfers', () => {
    it('should create new transfers from Explorer messages', async () => {
      const inflightMessages: ExplorerMessage[] = [
        {
          msg_id: '0xmsg1',
          origin_domain_id: 1,
          destination_domain_id: 2,
          sender: '0xuser1',
          recipient: '0xuser2',
          origin_tx_hash: '0xtx1',
          origin_tx_sender: '0xuser1',
          origin_tx_recipient: '0xrouter1',
          is_delivered: false,
          message_body:
            '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064',
        },
      ];

      explorerClient.getInflightUserTransfers.resolves(inflightMessages);

      await tracker.syncTransfers();

      const transfers = await transferStore.getAll();
      expect(transfers).to.have.lengthOf(1);
      expect(transfers[0].id).to.equal('0xmsg1');
      expect(transfers[0].status).to.equal('in_progress');
      expect(transfers[0].sender).to.equal('0xuser1');
      expect(transfers[0].amount).to.equal(100n);
    });

    it('should not duplicate transfers that already exist', async () => {
      // Pre-create transfer
      await transferStore.save({
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const inflightMessages: ExplorerMessage[] = [
        {
          msg_id: '0xmsg1',
          origin_domain_id: 1,
          destination_domain_id: 2,
          sender: '0xuser1',
          recipient: '0xuser2',
          origin_tx_hash: '0xtx1',
          origin_tx_sender: '0xuser1',
          origin_tx_recipient: '0xrouter1',
          is_delivered: false,
          message_body:
            '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064',
        },
      ];

      explorerClient.getInflightUserTransfers.resolves(inflightMessages);

      await tracker.syncTransfers();

      const transfers = await transferStore.getAll();
      expect(transfers).to.have.lengthOf(1);
    });

    it('should mark transfers as complete when delivered', async () => {
      // Pre-create transfer
      await transferStore.save({
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.delivered.resolves(true);

      await tracker.syncTransfers();

      const transfer = await transferStore.get('0xmsg1');
      expect(transfer?.status).to.equal('complete');
    });
  });

  describe('syncRebalanceIntents', () => {
    it('should mark intents as complete when fully fulfilled', async () => {
      // Intent derives completion from action states, so we need a complete action
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'complete',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      await tracker.syncRebalanceIntents();

      const updated = await rebalanceIntentStore.get('intent-1');
      expect(updated?.status).to.equal('complete');
    });

    it('should not mark intents as complete if not fully fulfilled', async () => {
      // Intent with only partial completion via actions
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'complete',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 50n, // Only partial
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      await tracker.syncRebalanceIntents();

      const updated = await rebalanceIntentStore.get('intent-1');
      expect(updated?.status).to.equal('in_progress');
    });
  });

  describe('syncRebalanceActions', () => {
    it('should mark actions as complete when delivered and update parent intent', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      mailboxStub.delivered.resolves(true);

      await tracker.syncRebalanceActions();

      // Action should be complete
      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('complete');

      // Intent should be complete (derived from completed action amounts)
      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('complete');
    });

    it('should not mark actions as complete if not delivered', async () => {
      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceActionStore.save(action);

      mailboxStub.delivered.resolves(false);

      await tracker.syncRebalanceActions();

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('in_progress');
    });
  });

  describe('getInProgressTransfers', () => {
    it('should return only in_progress transfers', async () => {
      await transferStore.save({
        id: 'transfer-1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender1',
        recipient: '0xrecipient1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await transferStore.save({
        id: 'transfer-2',
        status: 'complete',
        messageId: '0xmsg2',
        origin: 2,
        destination: 3,
        amount: 200n,
        sender: '0xsender2',
        recipient: '0xrecipient2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = await tracker.getInProgressTransfers();
      expect(result).to.have.lengthOf(1);
      expect(result[0].id).to.equal('transfer-1');
    });
  });

  describe('getActiveRebalanceIntents', () => {
    it('should return only in_progress intents (origin tx confirmed)', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-1',
        status: 'not_started',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceIntentStore.save({
        id: 'intent-2',
        status: 'in_progress',
        origin: 2,
        destination: 3,
        amount: 200n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceIntentStore.save({
        id: 'intent-3',
        status: 'complete',
        origin: 3,
        destination: 1,
        amount: 300n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Only in_progress intents are returned - their origin tx is confirmed
      // so simulation only needs to add to destination (origin already deducted on-chain)
      const result = await tracker.getActiveRebalanceIntents();
      expect(result).to.have.lengthOf(1);
      expect(result[0].id).to.equal('intent-2');
    });
  });

  describe('getPartiallyFulfilledInventoryIntents', () => {
    it('returns not_started inventory intents', async () => {
      // Create a not_started inventory intent (simulates failed execution before any action created)
      await rebalanceIntentStore.save({
        id: 'stuck-intent',
        status: 'not_started',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Should be returned even though status is 'not_started'
      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].intent.id).to.equal('stuck-intent');
      expect(partialIntents[0].completedAmount).to.equal(0n);
      expect(partialIntents[0].remaining).to.equal(1000000000000000000n);
    });

    it('returns in_progress inventory intents with partial completion', async () => {
      // Create an in_progress inventory intent with a completed action
      await rebalanceIntentStore.save({
        id: 'partial-intent',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Create a completed inventory_deposit action for partial amount
      await rebalanceActionStore.save({
        id: 'action-1',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'partial-intent',
        origin: 1,
        destination: 2,
        amount: 400000000000000000n, // 0.4 ETH completed
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].intent.id).to.equal('partial-intent');
      expect(partialIntents[0].completedAmount).to.equal(400000000000000000n);
      expect(partialIntents[0].remaining).to.equal(600000000000000000n); // 0.6 ETH remaining
    });

    it('does not return non-inventory intents', async () => {
      // Create a not_started intent without executionMethod: 'inventory'
      await rebalanceIntentStore.save({
        id: 'non-inventory-intent',
        status: 'not_started',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        // executionMethod is undefined - not an inventory intent
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(0);
    });
  });

  describe('createRebalanceIntent', () => {
    it('should create a new intent with status not_started', async () => {
      const result = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
        priority: 1,
        strategyType: 'MinAmountStrategy',
      });

      expect(result.status).to.equal('not_started');
      expect(result.origin).to.equal(1);
      expect(result.destination).to.equal(2);
      expect(result.amount).to.equal(100n);
      expect(result.priority).to.equal(1);
      expect(result.strategyType).to.equal('MinAmountStrategy');

      const stored = await rebalanceIntentStore.get(result.id);
      expect(stored).to.deep.equal(result);
    });
  });

  describe('createRebalanceAction', () => {
    it('should create action and transition intent from not_started to in_progress', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'not_started',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);

      const result = await tracker.createRebalanceAction({
        type: 'rebalance_message',
        intentId: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        messageId: '0xmsg1',
        txHash: '0xtx1',
      });

      expect(result.status).to.equal('in_progress');
      expect(result.intentId).to.equal('intent-1');
      expect(result.messageId).to.equal('0xmsg1');

      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('in_progress');
    });

    it('should not transition intent if already in_progress', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);

      await tracker.createRebalanceAction({
        type: 'rebalance_message',
        intentId: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 50n,
        messageId: '0xmsg2',
        txHash: '0xtx2',
      });

      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('in_progress');
    });
  });

  describe('completeRebalanceAction', () => {
    it('should mark action as complete and mark parent intent complete if fully fulfilled', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      await tracker.completeRebalanceAction('action-1');

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('complete');

      // Intent should be complete (derived from completed action amounts)
      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('complete');
    });

    it('should throw error when action not found', async () => {
      await expect(
        tracker.completeRebalanceAction('non-existent'),
      ).to.be.rejectedWith('RebalanceAction non-existent not found');
    });
  });

  describe('cancelRebalanceIntent', () => {
    it('should mark intent as cancelled', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'not_started',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);

      await tracker.cancelRebalanceIntent('intent-1');

      const updated = await rebalanceIntentStore.get('intent-1');
      expect(updated?.status).to.equal('cancelled');
    });
  });

  describe('failRebalanceAction', () => {
    it('should mark action as failed', async () => {
      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceActionStore.save(action);

      await tracker.failRebalanceAction('action-1');

      const updated = await rebalanceActionStore.get('action-1');
      expect(updated?.status).to.equal('failed');
    });
  });

  describe('Explorer query parameters', () => {
    it('should pass routersByDomain to getInflightRebalanceActions for warp route filtering', async () => {
      explorerClient.getInflightRebalanceActions.resolves([]);
      explorerClient.getInflightUserTransfers.resolves([]);

      await tracker.initialize();

      const call = explorerClient.getInflightRebalanceActions.firstCall;
      expect(call).to.not.be.null;

      const params = call.args[0];
      expect(params.routersByDomain).to.deep.equal(config.routersByDomain);
      expect(params.bridges).to.deep.equal(config.bridges);
      expect(params.rebalancerAddress).to.equal(config.rebalancerAddress);
    });

    it('should pass routersByDomain to getInflightUserTransfers for warp route filtering', async () => {
      explorerClient.getInflightRebalanceActions.resolves([]);
      explorerClient.getInflightUserTransfers.resolves([]);

      await tracker.initialize();

      const call = explorerClient.getInflightUserTransfers.firstCall;
      expect(call).to.not.be.null;

      const params = call.args[0];
      expect(params.routersByDomain).to.deep.equal(config.routersByDomain);
      expect(params.excludeTxSenders).to.deep.equal([config.rebalancerAddress]);
    });
  });

  describe('confirmedBlockTags synchronization', () => {
    it('should use provided blockTag in syncTransfers delivery check', async () => {
      await transferStore.save({
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.delivered.resolves(true);

      const confirmedBlockTags = { chain2: 12345 };
      await tracker.syncTransfers(confirmedBlockTags);

      expect(mailboxStub.delivered.calledOnce).to.be.true;
      const call = mailboxStub.delivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');
      expect(call.args[1]).to.deep.equal({ blockTag: 12345 });

      const transfer = await transferStore.get('0xmsg1');
      expect(transfer?.status).to.equal('complete');
    });

    it('should use provided blockTag in syncRebalanceActions delivery check', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const action: RebalanceAction = {
        id: 'action-1',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      explorerClient.getInflightRebalanceActions.resolves([]);
      mailboxStub.delivered.resolves(true);

      const confirmedBlockTags = { chain2: 99999 };
      await tracker.syncRebalanceActions(confirmedBlockTags);

      expect(mailboxStub.delivered.calledOnce).to.be.true;
      const call = mailboxStub.delivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');
      expect(call.args[1]).to.deep.equal({ blockTag: 99999 });

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('complete');
    });

    it('should handle string blockTags (like "safe" or "finalized")', async () => {
      await transferStore.save({
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.delivered.resolves(false);

      const confirmedBlockTags: ConfirmedBlockTags = {
        chain2: EthJsonRpcBlockParameterTag.Finalized,
      };
      await tracker.syncTransfers(confirmedBlockTags);

      expect(mailboxStub.delivered.calledOnce).to.be.true;
      const call = mailboxStub.delivered.firstCall;
      expect(call.args[1]).to.deep.equal({ blockTag: 'finalized' });
    });

    it('should handle undefined blockTag for chain not in confirmedBlockTags', async () => {
      await transferStore.save({
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 3,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.delivered.resolves(false);

      const confirmedBlockTags = { chain2: 12345 };
      await tracker.syncTransfers(confirmedBlockTags);

      expect(mailboxStub.delivered.calledOnce).to.be.true;
    });
  });
});
