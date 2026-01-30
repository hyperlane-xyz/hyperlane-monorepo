import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import sinon from 'sinon';

import { formatMessage, messageId } from '@hyperlane-xyz/utils';

import { ForkIndexer } from './ForkIndexer.js';
import { MockExplorerClient } from './MockExplorerClient.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

// Test addresses
const ROUTER_ADDRESS_1 = '0x1111111111111111111111111111111111111111';
const ROUTER_ADDRESS_2 = '0x2222222222222222222222222222222222222222';
const REBALANCER_ADDRESS = '0xReBA1ancer000000000000000000000000000000';
const USER_ADDRESS = '0xUser000000000000000000000000000000000000';

// Domain IDs
const DOMAIN_1 = 1;
const DOMAIN_2 = 2;

/**
 * Creates a properly formatted Hyperlane message for testing
 */
function createTestMessage(
  origin: number,
  destination: number,
  sender: string,
  recipient: string,
  body = '0x',
  nonce = 0,
): string {
  return formatMessage(3, nonce, origin, sender, destination, recipient, body);
}

/**
 * Creates a mock Dispatch event matching ethers event structure
 */
function createMockDispatchEvent(
  sender: string,
  message: string,
  txFrom: string,
  txHash = '0xtxhash123',
): any {
  return {
    args: {
      sender,
      message,
    },
    getTransactionReceipt: sinon.stub().resolves({
      transactionHash: txHash,
      from: txFrom,
    }),
  };
}

describe('ForkIndexer', () => {
  let provider1Stub: any;
  let provider2Stub: any;
  let providers: Map<string, any>;
  let coreStub: any;
  let mockExplorer: MockExplorerClient;
  let mailboxStub1: any;
  let mailboxStub2: any;
  let indexer: ForkIndexer;

  beforeEach(() => {
    // Create provider stubs
    provider1Stub = {
      getBlockNumber: sinon.stub(),
    };
    provider2Stub = {
      getBlockNumber: sinon.stub(),
    };

    providers = new Map([
      ['chain1', provider1Stub],
      ['chain2', provider2Stub],
    ]);

    // Create mailbox stubs with queryFilter
    mailboxStub1 = {
      queryFilter: sinon.stub().resolves([]),
      filters: {
        Dispatch: sinon.stub().returns('DispatchFilter'),
      },
    };
    mailboxStub2 = {
      queryFilter: sinon.stub().resolves([]),
      filters: {
        Dispatch: sinon.stub().returns('DispatchFilter'),
      },
    };

    // Create HyperlaneCore stub
    coreStub = {
      getContracts: sinon.stub().callsFake((chain: string) => {
        if (chain === 'chain1') return { mailbox: mailboxStub1 };
        if (chain === 'chain2') return { mailbox: mailboxStub2 };
        throw new Error(`Unknown chain: ${chain}`);
      }),
      multiProvider: {
        tryGetChainName: sinon.stub().callsFake((domain: number) => {
          if (domain === DOMAIN_1) return 'chain1';
          if (domain === DOMAIN_2) return 'chain2';
          return null;
        }),
      },
    };

    // Create MockExplorerClient
    mockExplorer = new MockExplorerClient();

    // Create ForkIndexer
    indexer = new ForkIndexer(
      providers,
      coreStub,
      mockExplorer,
      REBALANCER_ADDRESS,
      testLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('initialize', () => {
    it('should set lastScannedBlock to current block for each chain', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(200);

      await indexer.initialize();

      expect(provider1Stub.getBlockNumber.calledOnce).to.be.true;
      expect(provider2Stub.getBlockNumber.calledOnce).to.be.true;

      // Verify by calling sync - should not query any events since lastScanned == currentBlock
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(200);

      await indexer.sync();

      // queryFilter should not be called since lastScannedBlock >= currentBlock
      expect(mailboxStub1.queryFilter.called).to.be.false;
      expect(mailboxStub2.queryFilter.called).to.be.false;
    });
  });

  describe('sync - error handling', () => {
    it('should throw if called before initialize()', async () => {
      await expect(indexer.sync()).to.be.rejectedWith(
        'ForkIndexer not initialized. Call initialize() first.',
      );
    });
  });

  describe('sync - block range queries', () => {
    it('should query events from lastScannedBlock+1 to currentBlock', async () => {
      // Initialize at block 100
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Advance to block 150 for chain1
      provider1Stub.getBlockNumber.resolves(150);
      provider2Stub.getBlockNumber.resolves(100); // chain2 unchanged

      await indexer.sync();

      // Verify queryFilter was called with correct block range
      expect(mailboxStub1.queryFilter.calledOnce).to.be.true;
      const [filter, fromBlock, toBlock] =
        mailboxStub1.queryFilter.firstCall.args;
      expect(filter).to.equal('DispatchFilter');
      expect(fromBlock).to.equal(101); // lastScannedBlock + 1
      expect(toBlock).to.equal(150);

      // chain2 should not query since block didn't change
      expect(mailboxStub2.queryFilter.called).to.be.false;
    });
  });

  describe('sync - message conversion', () => {
    it('should convert Dispatch events to ExplorerMessage format correctly', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a test message
      const testMsg = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
        '0xdeadbeef',
      );
      const msgId = messageId(testMsg);
      const txHash = '0xabc123';

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        USER_ADDRESS,
        txHash,
      );

      mailboxStub1.queryFilter.resolves([mockEvent]);

      // Advance block and sync
      provider1Stub.getBlockNumber.resolves(110);
      provider2Stub.getBlockNumber.resolves(100);

      await indexer.sync();

      // Verify the MockExplorerClient received correct data
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );

      expect(userTransfers).to.have.lengthOf(1);
      const transfer = userTransfers[0];
      expect(transfer.msg_id).to.equal(msgId);
      expect(transfer.origin_domain_id).to.equal(DOMAIN_1);
      expect(transfer.destination_domain_id).to.equal(DOMAIN_2);
      expect(transfer.origin_tx_hash).to.equal(txHash);
      expect(transfer.origin_tx_sender).to.equal(USER_ADDRESS);
      expect(transfer.origin_tx_recipient).to.equal(ROUTER_ADDRESS_1);
      expect(transfer.is_delivered).to.be.false;
    });
  });

  describe('sync - deduplication', () => {
    it('should deduplicate messages by msg_id (same message not added twice)', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a test message
      const testMsg = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
      );

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        USER_ADDRESS,
      );

      // First sync with one event
      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Second sync returns the same event (simulating event requery overlap)
      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(120);
      await indexer.sync();

      // Should only have one transfer despite two events
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(1);
    });
  });

  describe('sync - no-op conditions', () => {
    it('should be a no-op when lastScannedBlock >= currentBlock', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Keep blocks the same
      await indexer.sync();

      expect(mailboxStub1.queryFilter.called).to.be.false;
      expect(mailboxStub2.queryFilter.called).to.be.false;

      // Even with block numbers less than last scanned (shouldn't happen but test edge case)
      provider1Stub.getBlockNumber.resolves(90);
      await indexer.sync();

      expect(mailboxStub1.queryFilter.called).to.be.false;
    });
  });

  describe('sync - incremental indexing', () => {
    it('should only index new events on multiple sync() calls (incremental)', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // First message at block 110
      const msg1 = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
        '0x01',
        1,
      );
      const event1 = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        msg1,
        USER_ADDRESS,
        '0xtx1',
      );

      mailboxStub1.queryFilter.resolves([event1]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Verify first query range
      expect(mailboxStub1.queryFilter.firstCall.args[1]).to.equal(101);
      expect(mailboxStub1.queryFilter.firstCall.args[2]).to.equal(110);

      // Second message at block 120
      const msg2 = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
        '0x02',
        2,
      );
      const event2 = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        msg2,
        USER_ADDRESS,
        '0xtx2',
      );

      mailboxStub1.queryFilter.resolves([event2]);
      provider1Stub.getBlockNumber.resolves(120);
      await indexer.sync();

      // Verify second query starts from where first left off
      expect(mailboxStub1.queryFilter.secondCall.args[1]).to.equal(111);
      expect(mailboxStub1.queryFilter.secondCall.args[2]).to.equal(120);

      // Should have both transfers
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(2);
    });
  });

  describe('sync - message classification', () => {
    it('should classify rebalancer txs as addRebalanceAction', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a message where tx sender is the rebalancer
      const testMsg = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
      );

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        REBALANCER_ADDRESS, // tx sender is rebalancer
      );

      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Should be in rebalance actions, not user transfers
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(0);

      const rebalanceActions = await mockExplorer.getInflightRebalanceActions(
        { routersByDomain: {}, bridges: [], rebalancerAddress: '' },
        testLogger,
      );
      expect(rebalanceActions).to.have.lengthOf(1);
    });

    it('should classify non-rebalancer txs as addUserTransfer', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a message where tx sender is a regular user
      const testMsg = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
      );

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        USER_ADDRESS, // tx sender is regular user
      );

      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Should be in user transfers, not rebalance actions
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(1);

      const rebalanceActions = await mockExplorer.getInflightRebalanceActions(
        { routersByDomain: {}, bridges: [], rebalancerAddress: '' },
        testLogger,
      );
      expect(rebalanceActions).to.have.lengthOf(0);
    });

    it('should classify correctly with case-insensitive address comparison', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a message where tx sender is rebalancer with different case
      const testMsg = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
      );

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        REBALANCER_ADDRESS.toLowerCase(), // lowercase
      );

      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Should still be classified as rebalance action
      const rebalanceActions = await mockExplorer.getInflightRebalanceActions(
        { routersByDomain: {}, bridges: [], rebalancerAddress: '' },
        testLogger,
      );
      expect(rebalanceActions).to.have.lengthOf(1);
    });
  });

  describe('sync - unknown destination chain', () => {
    it('should skip messages with unknown destination domain', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create a message to an unknown domain (999)
      const testMsg = createTestMessage(
        DOMAIN_1,
        999, // unknown domain
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
      );

      const mockEvent = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        testMsg,
        USER_ADDRESS,
      );

      mailboxStub1.queryFilter.resolves([mockEvent]);
      provider1Stub.getBlockNumber.resolves(110);
      await indexer.sync();

      // Should not add any transfers since destination is unknown
      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(0);
    });
  });

  describe('sync - multiple chains', () => {
    it('should index events from all chains', async () => {
      provider1Stub.getBlockNumber.resolves(100);
      provider2Stub.getBlockNumber.resolves(100);
      await indexer.initialize();

      // Create events for both chains
      const msg1 = createTestMessage(
        DOMAIN_1,
        DOMAIN_2,
        ROUTER_ADDRESS_1,
        ROUTER_ADDRESS_2,
        '0x01',
        1,
      );
      const event1 = createMockDispatchEvent(
        ROUTER_ADDRESS_1,
        msg1,
        USER_ADDRESS,
        '0xtx1',
      );

      const msg2 = createTestMessage(
        DOMAIN_2,
        DOMAIN_1,
        ROUTER_ADDRESS_2,
        ROUTER_ADDRESS_1,
        '0x02',
        2,
      );
      const event2 = createMockDispatchEvent(
        ROUTER_ADDRESS_2,
        msg2,
        USER_ADDRESS,
        '0xtx2',
      );

      mailboxStub1.queryFilter.resolves([event1]);
      mailboxStub2.queryFilter.resolves([event2]);

      provider1Stub.getBlockNumber.resolves(110);
      provider2Stub.getBlockNumber.resolves(110);

      await indexer.sync();

      const userTransfers = await mockExplorer.getInflightUserTransfers(
        { routersByDomain: {}, excludeTxSender: '' },
        testLogger,
      );
      expect(userTransfers).to.have.lengthOf(2);
    });
  });
});
