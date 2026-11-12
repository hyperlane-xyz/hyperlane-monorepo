import type { ConfirmedBlockTags } from '../interfaces/IMonitor.js';
import { HyperlaneMessageStatusAdapter } from '../bridges/status/HyperlaneMessageStatusAdapter.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Logger, pino } from 'pino';
import Sinon from 'sinon';

import { EthJsonRpcBlockParameterTag } from '@hyperlane-xyz/sdk';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  DEFAULT_INTENT_TTL_MS,
  DEFAULT_MOVEMENT_STALENESS_MS,
  ExternalBridgeType,
  TokenBridgeStatusAdapterType,
} from '../config/types.js';
import type {
  ITokenBridgeStatusAdapter,
  MCRStatusPollContext,
} from '../interfaces/ITokenBridgeStatusAdapter.js';
import {
  ID_A,
  ID_B,
  ID_C,
  buildMessage,
} from '../test/pendingTransferMiddlewareMocks.js';
import {
  ExplorerClient,
  type ExplorerMessage,
} from '../utils/ExplorerClient.js';

import {
  ActionTracker,
  type ActionTrackerConfig,
  TRANSFER_SYNC_ROW_LIMIT_MESSAGE,
} from './ActionTracker.js';
import { ExplorerRowLimitError } from './pendingTransferMiddlewares/PendingTransferMiddleware.js';
import { RelayerDenylistMiddleware } from './pendingTransferMiddlewares/RelayerDenylistMiddleware.js';
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

    // Create stub for adapter (used by MultiProtocolCore)
    mailboxStub = {
      isDelivered: Sinon.stub().resolves(false),
    };

    // Create stub for MultiProtocolCore
    const multiProviderGetChainName = Sinon.stub().callsFake(
      (domain: number) => `chain${domain}`,
    );
    const adapterStub = Sinon.stub().returns(mailboxStub);

    core = {
      adapter: adapterStub,
      multiProvider: {
        getChainName: multiProviderGetChainName,
        getChainMetadata: () => ({ protocol: ProtocolType.Sealevel }),
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
      intentTTL: DEFAULT_INTENT_TTL_MS,
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
          send_occurred_at: null,
        },
      ];

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);

      // Ensure mailbox returns false so action stays in_progress
      mailboxStub.isDelivered.resolves(false);

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

    it('should use send_occurred_at for createdAt when available', async () => {
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
          send_occurred_at: '2024-01-15T12:30:45',
        },
      ];

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.isDelivered.resolves(false);

      await tracker.initialize();

      const intents = await rebalanceIntentStore.getAll();
      expect(intents).to.have.lengthOf(1);
      // Hasura timestamps are UTC without 'Z'; recoverAction appends 'Z' before parsing
      const expectedMs = new Date('2024-01-15T12:30:45Z').getTime();
      expect(intents[0].createdAt).to.equal(expectedMs);

      const actions = await rebalanceActionStore.getAll();
      expect(actions[0].createdAt).to.equal(expectedMs);
    });

    it('should fall back to Date.now() when send_occurred_at is null', async () => {
      const before = Date.now();
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
          send_occurred_at: null,
        },
      ];

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.isDelivered.resolves(false);

      await tracker.initialize();
      const after = Date.now();

      const intents = await rebalanceIntentStore.getAll();
      expect(intents[0].createdAt).to.be.at.least(before);
      expect(intents[0].createdAt).to.be.at.most(after);
    });

    it('should skip action with invalid send_occurred_at timestamp', async () => {
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
          send_occurred_at: 'garbage',
        },
      ];

      explorerClient.getInflightRebalanceActions.resolves(inflightMessages);
      explorerClient.getInflightUserTransfers.resolves([]);
      mailboxStub.isDelivered.resolves(false);

      await tracker.initialize();

      // Invalid timestamp is caught by recoverAction's catch block, so the action is skipped
      const intents = await rebalanceIntentStore.getAll();
      expect(intents).to.have.lengthOf(0);
      const actions = await rebalanceActionStore.getAll();
      expect(actions).to.have.lengthOf(0);
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
          send_occurred_at: null,
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

    it('should link a restarted pre-send action by transaction hash', async () => {
      const inflightMessage: ExplorerMessage = {
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
        send_occurred_at: null,
      };
      await rebalanceIntentStore.save({
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await rebalanceActionStore.save({
        id: 'reserved-action',
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'intent-1',
        txHash: '0xTx1',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      explorerClient.getInflightRebalanceActions.resolves([inflightMessage]);

      await tracker.initialize();

      const actions = await rebalanceActionStore.getAll();
      expect(actions).to.have.lengthOf(1);
      expect(actions[0].id).to.equal('reserved-action');
      expect(actions[0].messageId).to.equal('0xmsg1');
      expect(await rebalanceIntentStore.getAll()).to.have.lengthOf(1);
    });
  });

  describe('Explorer recovery indexes', () => {
    const makeMessage = (
      id: string,
      txHash: string,
      origin = 1,
    ): ExplorerMessage => ({
      msg_id: id,
      origin_domain_id: origin,
      destination_domain_id: 2,
      sender: '0xrouter1',
      recipient: '0xrouter2',
      origin_tx_hash: txHash,
      origin_tx_sender: '0xrebalancer',
      origin_tx_recipient: '0xrouter1',
      is_delivered: false,
      message_body: `0x${'0'.repeat(126)}64`,
      send_occurred_at: null,
    });

    it('reports settlement discovered and completed within the same synchronization', async () => {
      explorerClient.getInflightRebalanceActions.resolves([
        makeMessage('0xmsg1', '0xtx1'),
      ]);
      mailboxStub.isDelivered.resolves(true);

      expect(await tracker.syncRebalanceActions()).to.equal(true);
      expect((await rebalanceActionStore.getAll())[0].status).to.equal(
        'complete',
      );
      expect(await tracker.syncRebalanceActions()).to.equal(false);
    });

    it('keeps a numeric snapshot usable when a newly discovered action completes at that block', async () => {
      explorerClient.getInflightRebalanceActions.resolves([
        makeMessage('0xmsg1', '0xtx1'),
      ]);
      mailboxStub.isDelivered.resolves(true);
      expect(await tracker.syncRebalanceActions({ chain2: 123 })).to.equal(
        false,
      );
      expect((await rebalanceActionStore.getAll())[0].status).to.equal(
        'complete',
      );
      expect(
        mailboxStub.isDelivered.calledOnceWithExactly('0xmsg1', 123),
      ).to.equal(true);
    });

    it('indexes the store once for a batch and deduplicates new identities', async () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
        makeMessage(`0xmsg${i}`, `0xtx${i}`),
      );
      explorerClient.getInflightRebalanceActions.resolves([
        ...messages,
        ...messages,
      ]);
      const readAll = Sinon.spy(rebalanceActionStore, 'getAll');
      await tracker.syncRebalanceActions();
      expect(readAll.callCount).to.equal(1);
      expect(await rebalanceActionStore.getAll()).to.have.length(100);
      expect(await rebalanceIntentStore.getAll()).to.have.length(100);
    });

    it('does not merge distinct messages dispatched by one transaction', async () => {
      explorerClient.getInflightRebalanceActions.resolves([
        makeMessage('0xmsg1', '0xtx'),
        makeMessage('0xmsg2', '0xtx'),
      ]);
      await tracker.syncRebalanceActions();
      expect(await rebalanceActionStore.getAll()).to.have.length(2);
    });

    for (const [hash, origin] of [
      ['0xSame', 3],
      ['SolanaSignature', 1],
    ] as const) {
      it(`preserves chain and signature case for ${hash}`, async () => {
        await rebalanceActionStore.save({
          id: 'reserved',
          type: 'rebalance_message',
          status: 'in_progress',
          intentId: 'intent',
          origin: 1,
          destination: 2,
          amount: 100n,
          txHash: hash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        explorerClient.getInflightRebalanceActions.resolves([
          makeMessage('0xmsg', hash.toLowerCase(), origin),
        ]);
        await tracker.syncRebalanceActions();
        expect(await rebalanceActionStore.getAll()).to.have.length(2);
        expect(
          (await rebalanceActionStore.get('reserved'))?.messageId,
        ).to.equal(undefined);
      });
    }
  });

  describe('syncTransfers', () => {
    it('reports a newly discovered transfer completed after balances were sampled', async () => {
      const message: ExplorerMessage = {
        msg_id: '0xmsg1',
        origin_domain_id: 1,
        destination_domain_id: 2,
        sender: '0xuser1',
        recipient: '0xuser2',
        origin_tx_hash: '0xtx1',
        origin_tx_sender: '0xuser1',
        origin_tx_recipient: '0xrouter1',
        is_delivered: false,
        message_body: `0x${'0'.repeat(126)}64`,
        send_occurred_at: null,
      };
      explorerClient.getInflightUserTransfers.resolves([message]);
      mailboxStub.isDelivered.resolves(true);

      expect(await tracker.syncTransfers()).to.equal(true);
      expect((await transferStore.get('0xmsg1'))?.status).to.equal('complete');
      expect(await tracker.syncTransfers()).to.equal(false);
    });

    it('keeps a numeric snapshot usable after user delivery at the same block', async () => {
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
      mailboxStub.isDelivered.resolves(true);
      expect(await tracker.syncTransfers({ chain2: 123 })).to.equal(false);
      expect((await transferStore.get('0xmsg1'))?.status).to.equal('complete');
      expect(
        mailboxStub.isDelivered.calledOnceWithExactly('0xmsg1', 123),
      ).to.equal(true);
    });

    for (const type of ['transfer', 'action']) {
      it(`rejects an incomplete ${type} delivery check without releasing its reservation`, async () => {
        const transfer: Transfer = {
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
        };
        const failure = new Error('Finalized state unavailable');
        mailboxStub.isDelivered.rejects(failure);
        if (type === 'transfer') {
          await transferStore.save(transfer);
          await expect(tracker.syncTransfers()).to.be.rejectedWith(failure);
          expect((await transferStore.get(transfer.id))?.status).to.equal(
            'in_progress',
          );
        } else {
          await rebalanceActionStore.save({
            ...transfer,
            type: 'rebalance_message',
            intentId: 'intent-1',
          });
          await expect(tracker.syncRebalanceActions()).to.be.rejectedWith(
            failure,
          );
          expect(
            (await rebalanceActionStore.get(transfer.id))?.status,
          ).to.equal('in_progress');
        }
      });
    }

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
          send_occurred_at: null,
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
          send_occurred_at: null,
        },
      ];

      explorerClient.getInflightUserTransfers.resolves(inflightMessages);

      await tracker.syncTransfers();

      const transfers = await transferStore.getAll();
      expect(transfers).to.have.lengthOf(1);
    });

    interface SyncFailureCase {
      name: string;
      error: Error;
      loggedAsError: boolean;
    }
    const syncFailures: SyncFailureCase[] = [
      {
        name: 'logs an Explorer row limit failure as an error and rethrows it',
        error: new ExplorerRowLimitError('row limit', []),
        loggedAsError: true,
      },
      {
        name: 'rethrows other Explorer failures without an error log',
        error: new Error('explorer down'),
        loggedAsError: false,
      },
    ];
    for (const c of syncFailures) {
      it(c.name, async () => {
        const logger: Logger = pino({ level: 'silent' });
        const error = Sinon.spy(logger, 'error');
        explorerClient.getInflightUserTransfers.rejects(c.error);
        const tracker = new ActionTracker(
          transferStore,
          rebalanceIntentStore,
          rebalanceActionStore,
          explorerClient,
          core,
          config,
          logger,
        );

        await expect(tracker.syncTransfers()).to.be.rejectedWith(c.error);

        expect(
          error.calledWith(
            Sinon.match({ error: c.error.message }),
            TRANSFER_SYNC_ROW_LIMIT_MESSAGE,
          ),
        ).to.equal(c.loggedAsError);
        expect(error.callCount).to.equal(c.loggedAsError ? 1 : 0);
      });
    }

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
      mailboxStub.isDelivered.resolves(true);

      await tracker.syncTransfers();

      const transfer = await transferStore.get('0xmsg1');
      expect(transfer?.status).to.equal('complete');
    });

    describe('with an ignored-transfer predicate', () => {
      const trackedTransfer: Transfer = {
        id: '0xmsg1',
        status: 'in_progress',
        messageId: '0xmsg1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xuser1',
        recipient: '0xuser2',
        createdAt: 1_000,
        updatedAt: 1_000,
      };

      function createTracker(
        isIgnoredTransfer: (messageId: string) => boolean,
        logger: Logger = testLogger,
      ): ActionTracker {
        return new ActionTracker(
          transferStore,
          rebalanceIntentStore,
          rebalanceActionStore,
          explorerClient,
          core,
          {
            routersByDomain: config.routersByDomain,
            isIgnoredTransfer,
            bridges: config.bridges,
            rebalancerAddress: config.rebalancerAddress,
            intentTTL: config.intentTTL,
          },
          logger,
        );
      }

      it('keeps an ignored tracked transfer stored but excludes it from in-progress transfers without checking delivery', async () => {
        await transferStore.save(trackedTransfer);
        const tracker = createTracker((id) => id === '0xmsg1');

        await tracker.syncTransfers();

        const transfer = await tracker.getTransfer('0xmsg1');
        expect(transfer?.status).to.equal('in_progress');
        expect(await tracker.getInProgressTransfers()).to.deep.equal([]);
        expect(mailboxStub.isDelivered.called).to.be.false;
      });

      it('reserves an ignored transfer again once it is no longer ignored, even when absent from the Explorer result', async () => {
        await transferStore.save(trackedTransfer);
        let ignored = true;
        const tracker = createTracker((id) => ignored && id === '0xmsg1');
        explorerClient.getInflightUserTransfers.resolves([]);

        await tracker.syncTransfers();
        expect(await tracker.getInProgressTransfers()).to.deep.equal([]);

        ignored = false;
        await tracker.syncTransfers();

        const inProgress = await tracker.getInProgressTransfers();
        expect(inProgress.map((t) => [t.id, t.amount])).to.deep.equal([
          ['0xmsg1', 100n],
        ]);
      });

      it('completes an ignored transfer on the first sync after it is no longer ignored once delivered', async () => {
        await transferStore.save(trackedTransfer);
        let ignored = true;
        const tracker = createTracker((id) => ignored && id === '0xmsg1');
        mailboxStub.isDelivered.resolves(true);

        await tracker.syncTransfers();
        expect(mailboxStub.isDelivered.called).to.be.false;
        expect((await tracker.getTransfer('0xmsg1'))?.status).to.equal(
          'in_progress',
        );

        ignored = false;
        await tracker.syncTransfers();

        expect(mailboxStub.isDelivered.calledOnce).to.be.true;
        expect((await tracker.getTransfer('0xmsg1'))?.status).to.equal(
          'complete',
        );
      });

      it('keeps a tracked transfer the predicate does not ignore', async () => {
        await transferStore.save(trackedTransfer);

        await createTracker((id) => id === '0xother').syncTransfers();

        const transfer = await transferStore.get('0xmsg1');

        expect(transfer?.status).to.equal('in_progress');
        expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      });

      it('counts an ignored transfer on every sync while it stays ignored', async () => {
        await transferStore.save(trackedTransfer);
        const logger: Logger = pino({ level: 'silent' });
        const info = Sinon.spy(logger, 'info');
        const tracker = createTracker((id) => id === '0xmsg1', logger);

        await tracker.syncTransfers();
        await tracker.syncTransfers();

        const syncedCounts = info
          .getCalls()
          .filter((call) => call.args.includes('Transfers synced'))
          .map((call) => call.args[0]);
        expect(syncedCounts).to.deep.equal([
          { newTransfers: 0, completed: 0, ignored: 1, inProgress: 0 },
          { newTransfers: 0, completed: 0, ignored: 1, inProgress: 0 },
        ]);
      });
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

    it('preserves source-started intents and actions beyond TTL', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now() - DEFAULT_INTENT_TTL_MS - 1,
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
        amount: 50n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);
      await rebalanceActionStore.save(action);

      await tracker.syncRebalanceIntents();

      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('in_progress');

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('in_progress');
    });

    it('expires an intent whose only source attempt was proven unsubmitted', async () => {
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
        executionMethod: 'inventory',
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'inventory_movement',
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      await tracker.failRebalanceAction(action.id);
      await rebalanceIntentStore.update(intent.id, {
        createdAt: Date.now() - DEFAULT_INTENT_TTL_MS - 1,
      });
      await tracker.syncRebalanceIntents();
      expect((await tracker.getRebalanceIntent(intent.id))?.status).to.equal(
        'failed',
      );
    });

    it('should preserve an expired intent after its inventory movement completes', async () => {
      const oldTimestamp = Date.now() - DEFAULT_INTENT_TTL_MS - 1;
      await rebalanceIntentStore.save({
        id: 'intent-completed-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        executionMethod: 'inventory',
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
      });
      await rebalanceActionStore.save({
        id: 'completed-movement',
        status: 'complete',
        type: 'inventory_movement',
        intentId: 'intent-completed-movement',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
      });

      await tracker.syncRebalanceIntents();

      expect(
        (await rebalanceIntentStore.get('intent-completed-movement'))?.status,
      ).to.equal('in_progress');
      expect(await rebalanceActionStore.get('completed-movement')).to.not.be
        .undefined;
    });

    it('should fail expired intents that never started execution', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now() - DEFAULT_INTENT_TTL_MS - 1,
        updatedAt: Date.now(),
      });

      await tracker.syncRebalanceIntents();

      const updatedIntent = await rebalanceIntentStore.get('intent-1');
      expect(updatedIntent?.status).to.equal('failed');
    });

    it('should not expire intents within TTL', async () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now() - DEFAULT_INTENT_TTL_MS + 60_000,
        updatedAt: Date.now(),
      };

      await rebalanceIntentStore.save(intent);

      await tracker.syncRebalanceIntents();

      const updated = await rebalanceIntentStore.get('intent-1');
      expect(updated?.status).to.equal('in_progress');
    });
  });

  describe('syncRebalanceActions', () => {
    it('retains balance-visible pending evidence through failed and incomplete polls until completion', async () => {
      const ref = { provider: 'lz_scan', kind: 'lz_scan', data: {} };
      const pollStatus = Sinon.stub();
      const statusAdapter: ITokenBridgeStatusAdapter = {
        kind: 'lz_scan',
        logger: testLogger,
        initFromReceipt: async () => ref,
        pollStatus,
      };
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        testLogger,
        new Map([[statusAdapter.kind, statusAdapter]]),
      );
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'rebalance_message',
        origin: 1,
        destination: 2,
        amount: 100n,
        externalExecutionRef: ref,
      });
      const tags: ConfirmedBlockTags = {
        chain2: EthJsonRpcBlockParameterTag.Finalized,
      };
      pollStatus.resolves({
        status: 'pending',
        balanceMayIncludePendingSettlement: true,
        ref,
      });
      expect(await tracker.syncRebalanceActions(tags)).to.equal(true);
      expect(
        (await rebalanceActionStore.get(action.id))?.externalExecutionRef?.data
          .balanceMayIncludePendingSettlement,
      ).to.equal(true);
      pollStatus.rejects(new Error('Scan unavailable'));
      expect(await tracker.syncRebalanceActions(tags)).to.equal(true);
      pollStatus.resolves({ status: 'pending', ref: { ...ref, data: {} } });
      expect(await tracker.syncRebalanceActions(tags)).to.equal(true);
      expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
        'in_progress',
      );
      expect(
        (await rebalanceActionStore.get(action.id))?.externalExecutionRef?.data
          .balanceMayIncludePendingSettlement,
      ).to.equal(true);
      pollStatus.resolves({
        status: 'complete',
        receivingTxHash: '0xdestination',
      });
      expect(await tracker.syncRebalanceActions(tags)).to.equal(true);
      expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
        'complete',
      );
      expect(await tracker.syncRebalanceActions(tags)).to.equal(false);
    });

    it('defers a failed Hyperlane adapter delivery read without releasing its action', async () => {
      const adapter = new HyperlaneMessageStatusAdapter(testLogger);
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        testLogger,
        new Map([[adapter.kind, adapter]]),
      );
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'rebalance_message',
        origin: 1,
        destination: 2,
        amount: 100n,
        externalExecutionRef: {
          provider: adapter.kind,
          kind: adapter.kind,
          data: { messageId: '0xmessage' },
        },
      });
      mailboxStub.isDelivered.rejects(new Error('solid state unavailable'));
      expect(
        await tracker.syncRebalanceActions({
          chain2: EthJsonRpcBlockParameterTag.Finalized,
        }),
      ).to.equal(true);
      expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
        'in_progress',
      );
      mailboxStub.isDelivered.resolves(false);
      expect(
        await tracker.syncRebalanceActions({
          chain2: EthJsonRpcBlockParameterTag.Finalized,
        }),
      ).to.equal(false);
    });

    it('records an LZ ref and completes its parent intent after delivery', async () => {
      const originalRef = {
        provider: TokenBridgeStatusAdapterType.LayerZeroScan,
        kind: TokenBridgeStatusAdapterType.LayerZeroScan,
        data: { originTxHash: '0xorigin' },
      };
      const refreshedRef = {
        ...originalRef,
        data: { ...originalRef.data, lastObservedStatus: 'DELIVERED' },
      };
      const pollStatus = Sinon.stub().resolves({
        status: 'complete',
        receivingTxHash: '0xdestination',
        ref: refreshedRef,
      });
      const statusAdapter: ITokenBridgeStatusAdapter = {
        kind: TokenBridgeStatusAdapterType.LayerZeroScan,
        logger: testLogger,
        initFromReceipt: Sinon.stub(),
        pollStatus,
      };
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        testLogger,
        new Map([[statusAdapter.kind, statusAdapter]]),
      );

      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'rebalance_message',
        origin: 1,
        destination: 2,
        amount: 100n,
        txHash: '0xorigin',
        externalExecutionRef: originalRef,
      });

      expect(
        (await rebalanceActionStore.get(action.id))?.externalExecutionRef,
      ).to.deep.equal(originalRef);

      await tracker.syncRebalanceActions({ chain2: 36 });
      expect(pollStatus.firstCall.args[1].blockTag).to.equal(36);

      const updatedAction = await rebalanceActionStore.get(action.id);
      expect(updatedAction?.status).to.equal('complete');
      expect(updatedAction?.externalExecutionRef).to.deep.equal(refreshedRef);
      expect(updatedAction?.destinationTxHash).to.equal('0xdestination');
      expect((await rebalanceIntentStore.get(intent.id))?.status).to.equal(
        'complete',
      );
      expect(pollStatus.calledOnceWith(originalRef)).to.be.true;
      expect(mailboxStub.isDelivered.called).to.be.false;
    });

    it('retains LZ credit across unchanged snapshots until the destination receipt is included', async () => {
      const ref = { provider: 'lz_scan', kind: 'lz_scan', data: {} };
      const statusAdapter: ITokenBridgeStatusAdapter = {
        kind: 'lz_scan',
        logger: testLogger,
        initFromReceipt: async () => ref,
        pollStatus: async (_ref, context: MCRStatusPollContext) =>
          typeof context.blockTag === 'number' && context.blockTag >= 37
            ? { status: 'complete', receivingTxHash: '0xdestination' }
            : { status: 'pending' },
      };
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        testLogger,
        new Map([[statusAdapter.kind, statusAdapter]]),
      );
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'rebalance_message',
        origin: 1,
        destination: 2,
        amount: 100n,
        txHash: '0xorigin',
        externalExecutionRef: ref,
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        await tracker.syncRebalanceActions({ chain2: 36 });
        expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
          'in_progress',
        );
        expect((await rebalanceIntentStore.get(intent.id))?.status).to.equal(
          'in_progress',
        );
      }
      await tracker.syncRebalanceActions({ chain2: 37 });
      expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
        'complete',
      );
    });

    it('keeps a source-committed LZ failure suppressed for the process lifetime', async () => {
      const ref = {
        provider: TokenBridgeStatusAdapterType.LayerZeroScan,
        kind: TokenBridgeStatusAdapterType.LayerZeroScan,
        data: { originTxHash: '0xorigin' },
      };
      const statusAdapter: ITokenBridgeStatusAdapter = {
        kind: TokenBridgeStatusAdapterType.LayerZeroScan,
        logger: testLogger,
        initFromReceipt: Sinon.stub(),
        pollStatus: Sinon.stub().resolves({
          status: 'failed',
          error: 'lz_blocked',
          ref,
        }),
      };
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        testLogger,
        new Map([[statusAdapter.kind, statusAdapter]]),
      );

      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'rebalance_message',
        origin: 1,
        destination: 2,
        amount: 100n,
        externalExecutionRef: ref,
      });

      await tracker.syncRebalanceActions();

      expect((await rebalanceActionStore.get(action.id))?.status).to.equal(
        'in_progress',
      );
      expect((await rebalanceIntentStore.get(intent.id))?.status).to.equal(
        'in_progress',
      );
      expect(
        (await rebalanceActionStore.get(action.id))?.lastBridgeStatus,
      ).to.equal('failed');
    });

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

      mailboxStub.isDelivered.resolves(true);

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

      mailboxStub.isDelivered.resolves(false);

      await tracker.syncRebalanceActions();

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('in_progress');
    });
  });

  describe('with a relayer denylist middleware', () => {
    let dir: string;
    let denylistPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'action-tracker-denylist-'));
      denylistPath = join(dir, 'denylist.json');
      writeDenylist([]);
      explorerClient.getInflightRebalanceActions.resolves([
        buildMessage(ID_A),
        buildMessage(ID_B),
        buildMessage(ID_C),
      ]);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function writeDenylist(
      messageIds: string[],
      matches: Record<string, unknown>[] = [],
    ): void {
      writeFileSync(
        denylistPath,
        JSON.stringify({
          rules: [
            ...messageIds.map((messageId) => ({ messageId })),
            ...matches,
          ].map((match) => ({ reason: 'settled', addedBy: 'tester', match })),
        }),
      );
    }

    async function createDenylistTracker(): Promise<ActionTracker> {
      const middleware = await RelayerDenylistMiddleware.create(
        explorerClient,
        { url: pathToFileURL(denylistPath).href, refreshIntervalMs: 0 },
        testLogger,
      );

      return new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        middleware,
        core,
        {
          routersByDomain: config.routersByDomain,
          isIgnoredTransfer: (id) => middleware.isIgnored(id),
          isIgnoredRebalanceAction: (id) =>
            middleware.isIgnoredRebalanceAction(id),
          bridges: config.bridges,
          rebalancerAddress: config.rebalancerAddress,
          intentTTL: config.intentTTL,
        },
        testLogger,
      );
    }

    async function activeIntentMessageIds(
      tracker: ActionTracker,
    ): Promise<string[]> {
      const actions = await rebalanceActionStore.getAll();
      const intents = await tracker.getActiveRebalanceIntents();

      return intents.map((intent) => {
        const action = actions.find((a) => a.intentId === intent.id);
        assert(action?.messageId, `Missing action for intent ${intent.id}`);
        return action.messageId;
      });
    }

    it('does not recover denylisted rebalance messages at startup', async () => {
      writeDenylist([ID_A, ID_B]);
      const tracker = await createDenylistTracker();

      await tracker.initialize();

      const actions = await rebalanceActionStore.getAll();
      expect(actions.map((a) => a.id)).to.deep.equal([ID_C]);
      const intents = await rebalanceIntentStore.getAll();
      expect(intents.map((i) => [i.status, i.amount])).to.deep.equal([
        ['in_progress', 100n],
      ]);
      expect(await activeIntentMessageIds(tracker)).to.deep.equal([ID_C]);
    });

    for (const operation of ['initialize', 'syncRebalanceActions'] as const) {
      it(`links an existing source transaction before denylist exclusion during ${operation}`, async () => {
        const message = buildMessage(ID_A);
        explorerClient.getInflightRebalanceActions.resolves([message]);
        const intent = await tracker.createRebalanceIntent({
          origin: message.origin_domain_id,
          destination: message.destination_domain_id,
          amount: 100n,
          executionMethod: 'movable_collateral',
        });
        const action = await tracker.createRebalanceAction({
          intentId: intent.id,
          type: 'rebalance_message',
          origin: intent.origin,
          destination: intent.destination,
          amount: intent.amount,
          txHash: message.origin_tx_hash,
        });
        await rebalanceIntentStore.update(intent.id, { createdAt: 0 });
        writeDenylist([ID_A]);
        const denylistTracker = await createDenylistTracker();

        await denylistTracker[operation]();
        await denylistTracker.syncRebalanceIntents();

        expect(await rebalanceActionStore.getAll()).to.have.lengthOf(1);
        expect(await rebalanceIntentStore.getAll()).to.have.lengthOf(1);
        expect(await rebalanceActionStore.get(action.id)).to.include({
          messageId: ID_A,
          txHash: message.origin_tx_hash,
          status: 'in_progress',
        });
        expect((await rebalanceIntentStore.get(intent.id))?.status).to.equal(
          'in_progress',
        );
        expect(await denylistTracker.getActiveRebalanceIntents()).to.be.empty;

        writeDenylist([]);
        await denylistTracker.syncRebalanceActions();
        expect(await activeIntentMessageIds(denylistTracker)).to.deep.equal([
          ID_A,
        ]);
        expect(await rebalanceActionStore.getAll()).to.have.lengthOf(1);
      });
    }

    it('retains inventory intent reservations when their message is denylisted', async () => {
      const message = buildMessage(ID_A);
      explorerClient.getInflightRebalanceActions.resolves([message]);
      const intent = await tracker.createRebalanceIntent({
        origin: message.origin_domain_id,
        destination: message.destination_domain_id,
        amount: 100n,
        executionMethod: 'inventory',
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        type: 'inventory_deposit',
        origin: intent.origin,
        destination: intent.destination,
        amount: intent.amount,
        txHash: message.origin_tx_hash,
      });
      await rebalanceIntentStore.update(intent.id, { createdAt: 0 });
      writeDenylist([ID_A]);
      const denylistTracker = await createDenylistTracker();

      await denylistTracker.syncRebalanceActions();
      await denylistTracker.syncRebalanceIntents();

      expect(await activeIntentMessageIds(denylistTracker)).to.deep.equal([
        ID_A,
      ]);
      expect(await rebalanceActionStore.get(action.id)).to.include({
        messageId: ID_A,
        status: 'in_progress',
      });
      expect((await rebalanceIntentStore.get(intent.id))?.status).to.equal(
        'in_progress',
      );
    });

    it('stops counting a tracked rebalance message once it is denylisted without changing its status', async () => {
      const tracker = await createDenylistTracker();
      await tracker.initialize();
      expect(await activeIntentMessageIds(tracker)).to.have.members([
        ID_A,
        ID_B,
        ID_C,
      ]);

      writeDenylist([ID_A]);
      mailboxStub.isDelivered.resetHistory();
      await tracker.syncRebalanceActions();

      expect(await activeIntentMessageIds(tracker)).to.have.members([
        ID_B,
        ID_C,
      ]);
      const ignoredAction = await rebalanceActionStore.get(ID_A);
      assert(ignoredAction, 'Expected the ignored action to stay stored');
      expect(ignoredAction.status).to.equal('in_progress');
      expect(
        (await rebalanceIntentStore.get(ignoredAction.intentId))?.status,
      ).to.equal('in_progress');
      expect(mailboxStub.isDelivered.calledWith(ID_A)).to.be.true;
    });

    it('completes a denylisted rebalance message the relayer still delivers', async () => {
      const tracker = await createDenylistTracker();
      await tracker.initialize();
      writeDenylist([ID_A]);
      mailboxStub.isDelivered.callsFake(async (id: string) => id === ID_A);

      await tracker.syncRebalanceActions();

      const action = await rebalanceActionStore.get(ID_A);
      assert(action, 'Expected the delivered action to stay stored');
      expect(action.status).to.equal('complete');
      expect(
        (await rebalanceIntentStore.get(action.intentId))?.status,
      ).to.equal('complete');
    });

    it('retains a denylisted source-started rebalance past the intent TTL', async () => {
      await rebalanceIntentStore.save({
        id: 'expired-intent',
        status: 'in_progress',
        origin: 42161,
        destination: 1,
        amount: 100n,
        createdAt: 0,
        updatedAt: 0,
      });
      await rebalanceActionStore.save({
        id: ID_A,
        type: 'rebalance_message',
        status: 'in_progress',
        intentId: 'expired-intent',
        messageId: ID_A,
        origin: 42161,
        destination: 1,
        amount: 100n,
        createdAt: 0,
        updatedAt: 0,
      });
      writeDenylist([ID_A]);
      const tracker = await createDenylistTracker();
      await tracker.syncRebalanceActions();
      expect(await activeIntentMessageIds(tracker)).to.have.members([
        ID_B,
        ID_C,
      ]);

      await tracker.syncRebalanceIntents();

      expect((await rebalanceActionStore.get(ID_A))?.status).to.equal(
        'in_progress',
      );
      expect(
        (await rebalanceIntentStore.get('expired-intent'))?.status,
      ).to.equal('in_progress');
    });

    it('keeps ignoring a denylisted rebalance message pushed off the Explorer page', async () => {
      const tracker = await createDenylistTracker();
      await tracker.initialize();
      writeDenylist([ID_A]);
      await tracker.syncRebalanceActions();
      expect(await activeIntentMessageIds(tracker)).to.not.include(ID_A);

      const newerIds = Array.from(
        { length: 100 },
        (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`,
      );
      explorerClient.getInflightRebalanceActions.resolves(
        newerIds.map((id) => buildMessage(id)),
      );
      await tracker.syncRebalanceActions();

      const countedIds = await activeIntentMessageIds(tracker);
      expect(countedIds).to.not.include(ID_A);
      expect(countedIds).to.include.members([ID_B, ID_C, ...newerIds]);

      writeDenylist([]);
      await tracker.syncRebalanceActions();

      expect(await activeIntentMessageIds(tracker)).to.include(ID_A);
    });

    it('keeps recovering and counting rebalance messages a broad rule denies', async () => {
      writeDenylist([], [{ destinationDomain: 1 }, { originDomain: 42161 }]);
      const tracker = await createDenylistTracker();

      await tracker.initialize();
      await tracker.syncRebalanceActions();

      expect(await activeIntentMessageIds(tracker)).to.have.members([
        ID_A,
        ID_B,
        ID_C,
      ]);
    });

    it('counts a rebalance message again once its rule is removed', async () => {
      writeDenylist([ID_A, ID_B]);
      const tracker = await createDenylistTracker();
      await tracker.initialize();
      expect(await activeIntentMessageIds(tracker)).to.deep.equal([ID_C]);

      writeDenylist([]);
      await tracker.syncRebalanceActions();

      expect(await activeIntentMessageIds(tracker)).to.have.members([
        ID_A,
        ID_B,
        ID_C,
      ]);
    });
  });

  describe('finalized source failure reconciliation', () => {
    async function reserveSource(
      type: RebalanceAction['type'] = 'inventory_movement',
      txHash?: string,
    ) {
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 100n,
        executionMethod:
          type === 'rebalance_message' ? 'movable_collateral' : 'inventory',
      });
      const action = await tracker.createRebalanceAction({
        intentId: intent.id,
        origin: 1,
        destination: 2,
        amount: 100n,
        type,
        txHash,
      });
      return { intent, action };
    }

    it('memoizes finalized source success for the exact hash while preserving its reservation', async () => {
      const { action } = await reserveSource(
        'inventory_movement',
        'source-hash',
      );
      const receipt = Sinon.stub().resolves({
        status: 1,
        blockNumber: 1,
        confirmations: 32,
      });
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Ethereum,
      );
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: receipt,
      });
      core.multiProvider.getChainMetadata = Sinon.stub().returns({});
      await tracker.syncRebalanceActions();
      await tracker.syncRebalanceActions();
      expect(receipt.callCount).to.equal(1);
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      await tracker.updateRebalanceActionExecution(action.id, {
        txHash: 'new-source-hash',
      });
      await tracker.syncRebalanceActions();
      expect(receipt.callCount).to.equal(2);
    });

    for (const protocol of [ProtocolType.Ethereum, ProtocolType.Tron]) {
      for (const type of [
        'rebalance_message',
        'inventory_movement',
        'inventory_deposit',
      ] as const) {
        it(`releases a finalized ${protocol} source revert for ${type} without waiting for TTL`, async () => {
          const { intent, action } = await reserveSource(type, 'source-hash');
          const receipt = Sinon.stub().resolves({
            status: 0,
            blockNumber: 1,
            confirmations: 1,
          });
          core.multiProvider.getProtocol = Sinon.stub().returns(protocol);
          const provider = Sinon.createStubInstance(TronJsonRpcProvider);
          provider.getTransactionReceipt.callsFake(receipt);
          provider.getFinalizedBlockNumber.resolves(1);
          core.multiProvider.getEthersV5Provider =
            Sinon.stub().returns(provider);
          core.multiProvider.getChainMetadata = Sinon.stub().returns({
            blocks: { reorgPeriod: 2 },
          });
          await tracker.syncRebalanceActions();
          expect(
            (await tracker.getRebalanceAction(action.id))?.status,
          ).to.equal('in_progress');
          receipt.resolves({ status: 0, blockNumber: 1, confirmations: 2 });
          await tracker.syncRebalanceActions();
          expect(
            (await tracker.getRebalanceAction(action.id))?.status,
          ).to.equal('failed');
          expect(
            (await tracker.getRebalanceIntent(intent.id))?.status,
          ).to.equal(type === 'rebalance_message' ? 'failed' : 'in_progress');
          if (type !== 'rebalance_message') {
            const [partial] =
              await tracker.getPartiallyFulfilledInventoryIntents();
            expect(partial.remaining).to.equal(100n);
            expect(partial.hasInflightDeposit).to.equal(false);
            expect(partial.hasInflightMovement).to.equal(false);
          }
        });
      }
    }

    for (const blocks of [
      { confirmations: 5, reorgPeriod: 2 },
      { confirmations: 2, reorgPeriod: 5 },
      { confirmations: 2 },
      undefined,
    ]) {
      it(`requires the full finality policy ${JSON.stringify(blocks)}`, async () => {
        const { action } = await reserveSource(
          'inventory_movement',
          'source-hash',
        );
        const minimum = blocks?.reorgPeriod === undefined ? 32 : 5;
        const receipt = Sinon.stub().resolves({
          status: 0,
          blockNumber: 1,
          confirmations: minimum - 1,
        });
        core.multiProvider.getProtocol = Sinon.stub().returns(
          ProtocolType.Ethereum,
        );
        core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
          getTransactionReceipt: receipt,
        });
        core.multiProvider.getChainMetadata = Sinon.stub().returns({ blocks });
        await tracker.syncRebalanceActions();
        expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
          'in_progress',
        );
        receipt.resolves({ status: 0, blockNumber: 1, confirmations: minimum });
        await tracker.syncRebalanceActions();
        expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
          'failed',
        );
      });
    }

    it('requires confirmations even after inclusion in a named finality block', async () => {
      const { action } = await reserveSource(
        'inventory_deposit',
        'source-hash',
      );
      const receipt = Sinon.stub().resolves({
        status: 0,
        blockNumber: 2,
        confirmations: 2,
      });
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Ethereum,
      );
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: receipt,
        getBlock: Sinon.stub().resolves({ number: 2 }),
      });
      core.multiProvider.getChainMetadata = Sinon.stub().returns({
        blocks: {
          confirmations: 3,
          reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        },
      });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      receipt.resolves({ status: 0, blockNumber: 2, confirmations: 3 });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'failed',
      );
    });

    it('requires the Tron receipt to be solidified as well as confirmed', async () => {
      const { action } = await reserveSource(
        'inventory_movement',
        'source-hash',
      );
      const provider = Sinon.createStubInstance(TronJsonRpcProvider);
      provider.getTransactionReceipt.callsFake(
        Sinon.stub().resolves({
          status: 0,
          blockNumber: 2,
          confirmations: 50,
        }),
      );
      provider.getFinalizedBlockNumber.resolves(1);
      core.multiProvider.getProtocol = Sinon.stub().returns(ProtocolType.Tron);
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns(provider);
      core.multiProvider.getChainMetadata = Sinon.stub().returns({
        blocks: { reorgPeriod: 2 },
      });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      provider.getFinalizedBlockNumber.rejects(
        new Error('solid node unavailable'),
      );
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      provider.getFinalizedBlockNumber.resolves(2);
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'failed',
      );
    });

    it('requires a source revert to be included in the configured finality tag', async () => {
      const { action } = await reserveSource(
        'inventory_deposit',
        'source-hash',
      );
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Ethereum,
      );
      const block = Sinon.stub().resolves({ number: 1 });
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: Sinon.stub().resolves({
          status: 0,
          blockNumber: 2,
          confirmations: 50,
        }),
        getBlock: block,
      });
      core.multiProvider.getChainMetadata = Sinon.stub().returns({
        blocks: { reorgPeriod: EthJsonRpcBlockParameterTag.Finalized },
      });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      block.resolves({ number: 2 });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'failed',
      );
      expect(block.firstCall.args[0]).to.equal(
        EthJsonRpcBlockParameterTag.Finalized,
      );
    });

    it('retains successful, absent, nonfinal and unreadable source receipts', async () => {
      const { action } = await reserveSource(
        'inventory_movement',
        'source-hash',
      );
      const receipt = Sinon.stub();
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Ethereum,
      );
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: receipt,
      });
      core.multiProvider.getChainMetadata = Sinon.stub().returns({
        blocks: { reorgPeriod: 2 },
      });
      for (const value of [
        null,
        { status: 1, confirmations: 5 },
        { status: 0, confirmations: 0 },
        { status: 0 },
      ]) {
        receipt.resolves(value);
        await tracker.syncRebalanceActions();
        expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
          'in_progress',
        );
      }
      receipt.rejects(new Error('RPC timeout'));
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
    });

    it('releases Solana execution errors only after finalization, with historical lookup', async () => {
      const { action } = await reserveSource(
        'inventory_deposit',
        'source-signature',
      );
      const status = Sinon.stub().resolves({
        value: [
          {
            confirmationStatus: 'confirmed',
            err: { InstructionError: [0, 'failure'] },
          },
        ],
      });
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Sealevel,
      );
      core.multiProvider.getSolanaWeb3Provider = Sinon.stub().returns({
        getSignatureStatuses: status,
      });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      status.resolves({
        value: [
          {
            confirmationStatus: 'finalized',
            err: { InstructionError: [0, 'failure'] },
          },
        ],
      });
      await tracker.syncRebalanceActions();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'failed',
      );
      expect(status.firstCall.args).to.deep.equal([
        ['source-signature'],
        { searchTransactionHistory: true },
      ]);
    });

    it('keeps absent and successful Solana signatures reserved instead of treating expiry as failure', async () => {
      const { action } = await reserveSource(
        'inventory_deposit',
        'source-signature',
      );
      const status = Sinon.stub();
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Sealevel,
      );
      core.multiProvider.getSolanaWeb3Provider = Sinon.stub().returns({
        getSignatureStatuses: status,
      });
      for (const value of [
        null,
        { confirmationStatus: 'finalized', err: null },
      ]) {
        status.resolves({ value: [value] });
        await tracker.syncRebalanceActions();
        expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
          'in_progress',
        );
      }
    });

    it('keeps a hashless unknown action reserved after the intent TTL', async () => {
      const { intent, action } = await reserveSource();
      await tracker.updateRebalanceActionExecution(action.id, {
        submissionState: 'unknown',
      });
      await rebalanceIntentStore.update(intent.id, {
        createdAt: Date.now() - config.intentTTL - 1,
      });
      await tracker.syncRebalanceActions();
      await tracker.syncRebalanceIntents();
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
      expect((await tracker.getRebalanceIntent(intent.id))?.status).to.equal(
        'in_progress',
      );
    });

    it('logs blocked age and identities without releasing uncertain work', async () => {
      const { action } = await reserveSource(
        'inventory_movement',
        'source-hash',
      );
      await rebalanceActionStore.update(action.id, {
        createdAt: Date.now() - 3_600_000 - 1000,
        lastBridgeStatus: 'failed',
      });
      const logger = pino({ level: 'silent' });
      const warn = Sinon.stub(logger, 'warn');
      const diagnosticTracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        explorerClient,
        core,
        config,
        logger,
      );
      await diagnosticTracker.logStoreContents();
      expect(warn.calledOnce).to.equal(true);
      expect(warn.firstCall.args[0]).to.include({
        actionId: action.id,
        txHash: 'source-hash',
        lastBridgeStatus: 'failed',
      });
      expect((await tracker.getRebalanceAction(action.id))?.status).to.equal(
        'in_progress',
      );
    });
  });

  describe('pending approval reconciliation', () => {
    async function reserveApproval(
      txHash: string | undefined = 'approval-hash',
    ) {
      await rebalanceActionStore.save({
        id: 'reserved',
        intentId: 'intent',
        type: 'inventory_movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submissionState: 'not_submitted',
        pendingApproval: { txHash },
      });
    }

    it('waits for finality and then releases a primary transaction that was never submitted', async () => {
      await reserveApproval();
      const receipt = Sinon.stub().resolves({
        status: 1,
        confirmations: 1,
        blockNumber: 1,
      });
      core.multiProvider.getProtocol = Sinon.stub().returns(
        ProtocolType.Ethereum,
      );
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: receipt,
      });
      core.multiProvider.getChainMetadata = Sinon.stub().returns({
        blocks: { reorgPeriod: 2 },
      });
      await tracker.syncRebalanceActions();
      expect((await rebalanceActionStore.get('reserved'))?.status).to.equal(
        'in_progress',
      );
      receipt.resolves({ status: 1, confirmations: 2, blockNumber: 1 });
      await tracker.syncRebalanceActions();
      const action = await rebalanceActionStore.get('reserved');
      expect(action?.status).to.equal('failed');
      expect(action?.txHash).to.equal(undefined);
      expect(action?.pendingApproval).to.equal(undefined);
    });

    it('retains unresolved approvals through provider timeouts and missing receipts', async () => {
      await reserveApproval();
      const receipt = Sinon.stub().rejects(new Error('RPC timeout'));
      core.multiProvider.getProtocol = Sinon.stub().returns(ProtocolType.Tron);
      core.multiProvider.getEthersV5Provider = Sinon.stub().returns({
        getTransactionReceipt: receipt,
      });
      await tracker.syncRebalanceActions();
      receipt.resolves(null);
      await tracker.syncRebalanceActions();
      expect((await rebalanceActionStore.get('reserved'))?.status).to.equal(
        'in_progress',
      );
    });
  });

  describe('syncInventoryMovementActions', () => {
    it('retains a failed source-committed movement beyond the intent TTL', async () => {
      await rebalanceIntentStore.save({
        id: 'intent',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: 0,
        updatedAt: 0,
      });
      await rebalanceActionStore.save({
        id: 'committed',
        intentId: 'intent',
        type: 'inventory_movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 100n,
        createdAt: 0,
        updatedAt: 0,
        submissionState: 'submitted',
        txHash: 'source-hash',
        externalBridgeId: ExternalBridgeType.LiFi,
      });
      const bridge = {
        logger: testLogger,
        externalBridgeId: 'lifi',
        quote: Sinon.stub(),
        execute: Sinon.stub(),
        getStatus: Sinon.stub().resolves({
          status: 'failed',
          error: 'provider failure',
        }),
      };
      expect(
        await tracker.syncInventoryMovementActions({
          [ExternalBridgeType.LiFi]: bridge,
        }),
      ).to.deep.equal({ completed: 0, failed: 0 });
      await tracker.syncRebalanceIntents();
      expect((await rebalanceActionStore.get('committed'))?.status).to.equal(
        'in_progress',
      );
      expect((await rebalanceIntentStore.get('intent'))?.status).to.equal(
        'in_progress',
      );
    });

    it('stores pending status on in-progress movement', async () => {
      await rebalanceActionStore.save({
        id: 'action-pending',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        txHash: '0xtx-pending',
        externalBridgeTransferId: 'transfer-pending',
        externalBridgeId: ExternalBridgeType.LiFi,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
      });

      const getStatus = Sinon.stub().resolves({ status: 'pending' });
      await tracker.syncInventoryMovementActions({
        lifi: { getStatus } as any,
      });

      expect(
        getStatus.calledOnceWithExactly(
          '0xtx-pending',
          1,
          2,
          'transfer-pending',
        ),
      ).to.equal(true);

      const action = await rebalanceActionStore.get('action-pending');
      expect(action?.status).to.equal('in_progress');
      expect(action?.lastBridgeStatus).to.equal('pending');
    });

    it('stores not_found status on in-progress movement', async () => {
      await rebalanceActionStore.save({
        id: 'action-not-found',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        txHash: '0xtx-not-found',
        externalBridgeId: ExternalBridgeType.LiFi,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
      });

      const getStatus = Sinon.stub().resolves({ status: 'not_found' });
      await tracker.syncInventoryMovementActions({
        lifi: { getStatus } as any,
      });

      const action = await rebalanceActionStore.get('action-not-found');
      expect(action?.status).to.equal('in_progress');
      expect(action?.lastBridgeStatus).to.equal('not_found');
    });

    it('updates the observed bridge status when it returns to pending', async () => {
      await rebalanceActionStore.save({
        id: 'action-back-to-pending',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        txHash: '0xtx-back-pending',
        externalBridgeId: ExternalBridgeType.LiFi,
        lastBridgeStatus: 'not_found',
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now(),
      });

      const getStatus = Sinon.stub().resolves({ status: 'pending' });
      await tracker.syncInventoryMovementActions({
        lifi: { getStatus } as any,
      });

      const action = await rebalanceActionStore.get('action-back-to-pending');
      expect(action?.lastBridgeStatus).to.equal('pending');
    });

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

    describe('with an ignored-rebalance-action predicate', () => {
      const ignoredIds = new Set(['0xignored1', '0xignored2']);

      function createTracker(
        isIgnoredRebalanceAction?: (messageId: string) => boolean,
      ): ActionTracker {
        return new ActionTracker(
          transferStore,
          rebalanceIntentStore,
          rebalanceActionStore,
          explorerClient,
          core,
          {
            routersByDomain: config.routersByDomain,
            isIgnoredRebalanceAction,
            bridges: config.bridges,
            rebalancerAddress: config.rebalancerAddress,
            intentTTL: config.intentTTL,
          },
          testLogger,
        );
      }

      async function saveIntent(
        id: string,
        executionMethod?: 'movable_collateral' | 'inventory',
      ): Promise<void> {
        await rebalanceIntentStore.save({
          id,
          status: 'in_progress',
          origin: 1,
          destination: 2,
          amount: 300n,
          executionMethod,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      async function saveAction(
        id: string,
        intentId: string,
        type: 'rebalance_message' | 'inventory_deposit',
        status: 'in_progress' | 'complete',
      ): Promise<void> {
        await rebalanceActionStore.save({
          id,
          type,
          status,
          intentId,
          messageId: id,
          origin: 1,
          destination: 2,
          amount: 100n,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      it('drops only intents whose in-progress messages are all ignored', async () => {
        await saveIntent('all-ignored', 'movable_collateral');
        await saveAction(
          '0xignored1',
          'all-ignored',
          'rebalance_message',
          'in_progress',
        );
        await saveAction(
          '0xdone',
          'all-ignored',
          'rebalance_message',
          'complete',
        );
        await saveIntent('mixed');
        await saveAction(
          '0xignored2',
          'mixed',
          'rebalance_message',
          'in_progress',
        );
        await saveAction('0xkept', 'mixed', 'rebalance_message', 'in_progress');
        await saveIntent('no-actions', 'movable_collateral');

        const result = await createTracker((id) =>
          ignoredIds.has(id),
        ).getActiveRebalanceIntents();

        expect(result.map((i) => [i.id, i.amount])).to.have.deep.members([
          ['mixed', 300n],
          ['no-actions', 300n],
        ]);
      });

      it('leaves inventory intents and their retry state untouched', async () => {
        await saveIntent('inventory', 'inventory');
        await saveAction(
          '0xignored1',
          'inventory',
          'inventory_deposit',
          'in_progress',
        );

        const withoutPredicate = createTracker();
        const withPredicate = createTracker((id) => ignoredIds.has(id));

        expect(
          (await withPredicate.getActiveRebalanceIntents()).map((i) => i.id),
        ).to.deep.equal(['inventory']);
        expect(
          await withPredicate.getPartiallyFulfilledInventoryIntents(),
        ).to.deep.equal(
          await withoutPredicate.getPartiallyFulfilledInventoryIntents(),
        );
        expect(
          await withPredicate.getPartiallyFulfilledInventoryIntents(),
        ).to.have.lengthOf(1);
      });
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

    it('ignores inventory_movement amounts when computing remaining', async () => {
      await rebalanceIntentStore.save({
        id: 'partial-intent-with-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceActionStore.save({
        id: 'action-deposit',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'partial-intent-with-movement',
        origin: 1,
        destination: 2,
        amount: 400000000000000000n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceActionStore.save({
        id: 'action-movement',
        type: 'inventory_movement',
        status: 'complete',
        intentId: 'partial-intent-with-movement',
        origin: 3,
        destination: 2,
        amount: 9000000000000000000n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].intent.id).to.equal(
        'partial-intent-with-movement',
      );
      expect(partialIntents[0].completedAmount).to.equal(400000000000000000n);
      expect(partialIntents[0].remaining).to.equal(600000000000000000n);
    });

    it('returns an active intent with an in-flight inventory movement', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-with-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceActionStore.save({
        id: 'movement-in-progress',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-with-movement',
        origin: 3,
        destination: 2,
        amount: 1100000000000000000n,
        txHash: '0xsource',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].remaining).to.equal(1000000000000000000n);
      expect(partialIntents[0].hasInflightMovement).to.be.true;
      expect(partialIntents[0].hasInflightDeposit).to.be.false;
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

    it('returns intent with in-flight deposit and sets hasInflightDeposit flag', async () => {
      // Setup: in_progress inventory intent (amount: 1 ETH = 1_000_000_000_000_000_000n)
      await rebalanceIntentStore.save({
        id: 'intent-with-inflight',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Complete inventory_deposit action (amount: 400_000_000_000_000_000n = 0.4 ETH)
      await rebalanceActionStore.save({
        id: 'action-complete',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'intent-with-inflight',
        origin: 1,
        destination: 2,
        amount: 400000000000000000n, // 0.4 ETH completed
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // In_progress inventory_deposit action (amount: 300_000_000_000_000_000n = 0.3 ETH)
      await rebalanceActionStore.save({
        id: 'action-inflight',
        type: 'inventory_deposit',
        status: 'in_progress',
        intentId: 'intent-with-inflight',
        origin: 1,
        destination: 2,
        amount: 300000000000000000n, // 0.3 ETH in-flight
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightDeposit).to.be.true;
      expect(partialIntents[0].completedAmount).to.equal(400000000000000000n);
      expect(partialIntents[0].remaining).to.equal(300000000000000000n); // 1.0 - 0.4 - 0.3
    });

    it('returns intent without in-flight deposit with hasInflightDeposit false', async () => {
      // Setup: in_progress inventory intent (amount: 1 ETH)
      await rebalanceIntentStore.save({
        id: 'intent-no-inflight',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Complete inventory_deposit action (amount: 0.4 ETH)
      await rebalanceActionStore.save({
        id: 'action-complete-only',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'intent-no-inflight',
        origin: 1,
        destination: 2,
        amount: 400000000000000000n, // 0.4 ETH completed
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // NO in_progress inventory_deposit actions

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightDeposit).to.be.false;
      expect(partialIntents[0].remaining).to.equal(600000000000000000n);
    });

    it('returns intent when remaining is 0n but has in-flight deposit', async () => {
      // intent.amount = 1 ETH, completedAmount = 0.7 ETH, inflightAmount = 0.3 ETH → remaining = 0n
      await rebalanceIntentStore.save({
        id: 'intent-zero-remaining',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 0.7 ETH already completed
      await rebalanceActionStore.save({
        id: 'action-complete-part',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'intent-zero-remaining',
        origin: 1,
        destination: 2,
        amount: 700000000000000000n, // 0.7 ETH
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 0.3 ETH in-flight — exactly fills the remaining gap
      await rebalanceActionStore.save({
        id: 'action-inflight-rest',
        type: 'inventory_deposit',
        status: 'in_progress',
        intentId: 'intent-zero-remaining',
        origin: 1,
        destination: 2,
        amount: 300000000000000000n, // 0.3 ETH in-flight
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].remaining).to.equal(0n);
      expect(partialIntents[0].hasInflightDeposit).to.be.true;
      expect(partialIntents[0].completedAmount).to.equal(700000000000000000n);
    });

    it('does not return fully completed intent with no in-flight deposits', async () => {
      // intent.amount = 1 ETH, completedAmount = 1 ETH, inflightAmount = 0 → remaining = 0n, no inflight
      await rebalanceIntentStore.save({
        id: 'intent-fully-done',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Full amount completed
      await rebalanceActionStore.save({
        id: 'action-all-done',
        type: 'inventory_deposit',
        status: 'complete',
        intentId: 'intent-fully-done',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n, // 1 ETH — full amount
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();

      // remaining = 0n AND inflightAmount = 0n → should NOT be returned
      expect(partialIntents).to.have.lengthOf(0);
    });

    it('returns intent with a blocking in-flight inventory movement', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-recent-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Recent movement (created just now)
      await rebalanceActionStore.save({
        id: 'movement-recent',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-recent-movement',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.equal(true);
    });

    it('retains stale movement and returns blocked intent', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-stale-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Stale movement (non-pending for > 30 min)
      await rebalanceActionStore.save({
        id: 'movement-stale',
        type: 'inventory_movement',
        status: 'in_progress',
        lastBridgeStatus: 'not_found',
        intentId: 'intent-stale-movement',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.be.true;

      // Staleness is not evidence that the source never committed.
      const failedAction = await rebalanceActionStore.get('movement-stale');
      expect(failedAction?.status).to.equal('in_progress');
    });

    it('retains stale movement with undefined lastBridgeStatus (pre-deploy data)', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-undefined-status',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Stale movement without lastBridgeStatus (simulates pre-deploy data)
      await rebalanceActionStore.save({
        id: 'movement-undefined-status',
        type: 'inventory_movement',
        status: 'in_progress',
        intentId: 'intent-undefined-status',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.be.true;

      const action = await rebalanceActionStore.get(
        'movement-undefined-status',
      );
      expect(action?.status).to.equal('in_progress');
    });

    it('does not fail long-running pending movement', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-pending-movement',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await rebalanceActionStore.save({
        id: 'movement-pending-old',
        type: 'inventory_movement',
        status: 'in_progress',
        lastBridgeStatus: 'pending',
        intentId: 'intent-pending-movement',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.equal(true);

      const action = await rebalanceActionStore.get('movement-pending-old');
      expect(action?.status).to.equal('in_progress');
    });

    it('does not fail old movement that recently became non-pending', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-recent-not-found',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Old by createdAt but only recently transitioned to not_found
      await rebalanceActionStore.save({
        id: 'movement-recent-not-found',
        type: 'inventory_movement',
        status: 'in_progress',
        lastBridgeStatus: 'not_found',
        intentId: 'intent-recent-not-found',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now(),
      });

      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.equal(true);

      const action = await rebalanceActionStore.get(
        'movement-recent-not-found',
      );
      expect(action?.status).to.equal('in_progress');
    });

    it('handles mix of recent and stale movements', async () => {
      await rebalanceIntentStore.save({
        id: 'intent-mixed-movements',
        status: 'in_progress',
        origin: 1,
        destination: 2,
        amount: 1000000000000000000n,
        executionMethod: 'inventory',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // One stale movement (non-pending for > 30 min)
      await rebalanceActionStore.save({
        id: 'movement-old',
        type: 'inventory_movement',
        status: 'in_progress',
        lastBridgeStatus: 'not_found',
        intentId: 'intent-mixed-movements',
        origin: 1,
        destination: 2,
        amount: 500000000000000000n,
        createdAt: Date.now() - DEFAULT_MOVEMENT_STALENESS_MS - 1,
        updatedAt: Date.now(),
      });

      // One recent movement
      await rebalanceActionStore.save({
        id: 'movement-new',
        type: 'inventory_movement',
        status: 'in_progress',
        lastBridgeStatus: 'pending',
        intentId: 'intent-mixed-movements',
        origin: 1,
        destination: 2,
        amount: 500000000000000000n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Keep the intent visible and blocked while either movement is outstanding.
      const partialIntents =
        await tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents).to.have.lengthOf(1);
      expect(partialIntents[0].hasInflightMovement).to.equal(true);

      const staleAction = await rebalanceActionStore.get('movement-old');
      expect(staleAction?.status).to.equal('in_progress');
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

    it('persists external bridge transfer identifiers', async () => {
      const intent = await tracker.createRebalanceIntent({
        origin: 1,
        destination: 2,
        amount: 50n,
        executionMethod: 'inventory',
      });
      const result = await tracker.createRebalanceAction({
        type: 'inventory_movement',
        intentId: intent.id,
        origin: 1,
        destination: 2,
        amount: 50n,
        txHash: '0xmovement',
        externalBridgeTransferId: 'provider-transfer-id',
        externalBridgeId: ExternalBridgeType.LiFi,
      });

      expect(result.externalBridgeTransferId).to.equal('provider-transfer-id');
      expect(result.status).to.equal('in_progress');
      const stored = await rebalanceActionStore.get(result.id);
      expect(stored?.externalBridgeTransferId).to.equal('provider-transfer-id');
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

  describe('delivery check synchronization', () => {
    it('should check delivery status in syncTransfers using adapter', async () => {
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
      mailboxStub.isDelivered.resolves(true);

      await tracker.syncTransfers();

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');

      const transfer = await transferStore.get('0xmsg1');
      expect(transfer?.status).to.equal('complete');
    });

    it('should check delivery status in syncRebalanceActions using adapter', async () => {
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
      mailboxStub.isDelivered.resolves(true);

      await tracker.syncRebalanceActions();

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('complete');
    });

    it('checks tracked delivery with the real Explorer client and no bridges', async () => {
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
        type: 'inventory_deposit',
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

      config.bridges = [];
      const fetchStub = Sinon.stub(globalThis, 'fetch').rejects(
        new Error('unexpected HTTP'),
      );
      tracker = new ActionTracker(
        transferStore,
        rebalanceIntentStore,
        rebalanceActionStore,
        new ExplorerClient(
          'https://explorer.test',
          () => ProtocolType.Ethereum,
        ),
        core,
        config,
        testLogger,
      );
      mailboxStub.isDelivered.resolves(true);

      try {
        await tracker.syncRebalanceActions();
        expect(fetchStub.called).to.be.false;
      } finally {
        fetchStub.restore();
      }

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');

      const updatedAction = await rebalanceActionStore.get('action-1');
      expect(updatedAction?.status).to.equal('complete');
    });

    it('should keep transfer in_progress when not delivered', async () => {
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
      mailboxStub.isDelivered.resolves(false);

      await tracker.syncTransfers();

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const transfer = await transferStore.get('0xmsg1');
      expect(transfer?.status).to.equal('in_progress');
    });

    it('should check delivery for multiple destinations', async () => {
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
      mailboxStub.isDelivered.resolves(false);

      await tracker.syncTransfers();

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
    });

    it('should pass blockTag when checking delivery in syncTransfers', async () => {
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
      mailboxStub.isDelivered.resolves(true);

      const confirmedBlockTags = {
        chain2: 12345,
      };
      await tracker.syncTransfers(confirmedBlockTags);

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');
      expect(call.args[1]).to.equal(12345);
    });

    it('should pass blockTag when checking delivery in syncRebalanceActions', async () => {
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
        status: 'in_progress',
        type: 'rebalance_message',
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
      mailboxStub.isDelivered.resolves(true);

      const confirmedBlockTags = { chain2: 12345 };
      await tracker.syncRebalanceActions(confirmedBlockTags);

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');
      expect(call.args[1]).to.equal(12345);
    });

    it('should pass undefined blockTag when confirmedBlockTags not provided', async () => {
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
      mailboxStub.isDelivered.resolves(false);

      await tracker.syncTransfers(); // No confirmedBlockTags

      expect(mailboxStub.isDelivered.calledOnce).to.be.true;
      const call = mailboxStub.isDelivered.firstCall;
      expect(call.args[0]).to.equal('0xmsg1');
      expect(call.args[1]).to.be.undefined;
    });
  });
});
