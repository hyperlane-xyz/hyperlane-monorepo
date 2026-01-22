import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon, { type SinonStubbedInstance } from 'sinon';

import {
  type ChainName,
  type MultiProvider,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';

import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type { InventoryRoute } from '../interfaces/IInventoryRebalancer.js';
import { createMockBridgeQuote } from '../test/lifiMocks.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../tracking/types.js';

import {
  InventoryRebalancer,
  type InventoryRebalancerConfig,
} from './InventoryRebalancer.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

describe('InventoryRebalancer E2E', () => {
  let inventoryRebalancer: InventoryRebalancer;
  let config: InventoryRebalancerConfig;
  let inventoryMonitor: SinonStubbedInstance<IInventoryMonitor>;
  let actionTracker: SinonStubbedInstance<IActionTracker>;
  let bridge: SinonStubbedInstance<IExternalBridge>;
  let warpCore: any;
  let multiProvider: any;
  let adapterStub: any;

  // Test constants
  const ARBITRUM_CHAIN = 'arbitrum' as ChainName;
  const SOLANA_CHAIN = 'solanamainnet' as ChainName;
  const ARBITRUM_DOMAIN = 42161;
  const SOLANA_DOMAIN = 1399811149;
  const INVENTORY_SIGNER = '0xInventorySigner';

  beforeEach(() => {
    // Config
    config = {
      inventorySigner: INVENTORY_SIGNER,
      inventoryChains: [ARBITRUM_CHAIN, SOLANA_CHAIN],
    };

    // Mock IInventoryMonitor
    inventoryMonitor = {
      getBalances: Sinon.stub(),
      getAvailableInventory: Sinon.stub(),
      refresh: Sinon.stub(),
    } as SinonStubbedInstance<IInventoryMonitor>;

    // Mock IActionTracker
    actionTracker = {
      initialize: Sinon.stub(),
      syncTransfers: Sinon.stub(),
      syncRebalanceIntents: Sinon.stub(),
      syncRebalanceActions: Sinon.stub(),
      syncInventoryMovementActions: Sinon.stub(),
      getInProgressTransfers: Sinon.stub(),
      getTransfersByDestination: Sinon.stub(),
      getActiveRebalanceIntents: Sinon.stub(),
      getRebalanceIntentsByDestination: Sinon.stub(),
      createRebalanceIntent: Sinon.stub(),
      completeRebalanceIntent: Sinon.stub(),
      cancelRebalanceIntent: Sinon.stub(),
      failRebalanceIntent: Sinon.stub(),
      getActionsByType: Sinon.stub(),
      getInflightInventoryMovements: Sinon.stub(),
      createRebalanceAction: Sinon.stub(),
      completeRebalanceAction: Sinon.stub(),
      failRebalanceAction: Sinon.stub(),
      logStoreContents: Sinon.stub(),
    } as SinonStubbedInstance<IActionTracker>;

    // Mock IExternalBridge (LiFi)
    bridge = {
      bridgeId: 'lifi',
      quote: Sinon.stub(),
      execute: Sinon.stub(),
      getStatus: Sinon.stub(),
    } as unknown as SinonStubbedInstance<IExternalBridge>;

    // Mock adapter for WarpCore tokens
    adapterStub = {
      quoteTransferRemoteGas: Sinon.stub().resolves({
        igpQuote: { amount: 1000000n },
      }),
      populateTransferRemoteTx: Sinon.stub().resolves({
        to: '0xRouterAddress',
        data: '0xTransferRemoteData',
        value: 1000000n,
      }),
    };

    // Mock WarpCore with tokens for both chains
    // Note: We need tokens for both origin (surplus) and destination (deficit) chains
    // because transferRemote is called FROM destination (after direction swap)
    const arbitrumToken = {
      chainName: ARBITRUM_CHAIN,
      standard: TokenStandard.EvmHypCollateral, // Non-native: no IGP reservation needed
      getHypAdapter: Sinon.stub().returns(adapterStub),
    };
    const solanaToken = {
      chainName: SOLANA_CHAIN,
      standard: TokenStandard.EvmHypCollateral, // Non-native: no IGP reservation needed
      getHypAdapter: Sinon.stub().returns(adapterStub),
    };

    warpCore = {
      tokens: [arbitrumToken, solanaToken],
      multiProvider: {
        getProvider: Sinon.stub(),
        getSigner: Sinon.stub(),
      },
    };

    // Mock provider with getFeeData for gas estimation, estimateGas for actual gas estimation,
    // and waitForTransaction for confirmations
    const mockProvider = {
      getFeeData: Sinon.stub().resolves({
        maxFeePerGas: 10000000000n, // 10 gwei
        gasPrice: 10000000000n,
      }),
      estimateGas: Sinon.stub().resolves(300000n), // Mock gas estimate for transferRemote
      waitForTransaction: Sinon.stub().resolves({
        blockNumber: 100,
        status: 1,
      }),
    };

    // Mock MultiProvider
    multiProvider = {
      getDomainId: Sinon.stub().callsFake((chain: ChainName) => {
        if (chain === ARBITRUM_CHAIN) return ARBITRUM_DOMAIN;
        if (chain === SOLANA_CHAIN) return SOLANA_DOMAIN;
        return 0;
      }),
      getChainName: Sinon.stub().callsFake((domain: number) => {
        if (domain === ARBITRUM_DOMAIN) return ARBITRUM_CHAIN;
        if (domain === SOLANA_DOMAIN) return SOLANA_CHAIN;
        return 'unknown';
      }),
      getChainMetadata: Sinon.stub().returns({
        blocks: { reorgPeriod: 1 }, // Quick confirmations for tests
      }),
      getProvider: Sinon.stub().returns(mockProvider),
      sendTransaction: Sinon.stub().resolves({
        transactionHash: '0xTransferRemoteTxHash',
        logs: [], // Required for HyperlaneCore.getDispatchedMessages
      }),
    };

    // Create InventoryRebalancer
    inventoryRebalancer = new InventoryRebalancer(
      config,
      inventoryMonitor,
      actionTracker as unknown as IActionTracker,
      bridge as unknown as IExternalBridge,
      warpCore as unknown as WarpCore,
      multiProvider as unknown as MultiProvider,
      testLogger,
    );
  });

  afterEach(() => {
    Sinon.restore();
  });

  // Helper to create test routes and intents
  function createTestRoute(
    overrides?: Partial<InventoryRoute>,
  ): InventoryRoute {
    return {
      origin: ARBITRUM_CHAIN,
      destination: SOLANA_CHAIN,
      amount: 10000000000n, // 10k USDC (6 decimals)
      ...overrides,
    };
  }

  function createTestIntent(
    overrides?: Partial<RebalanceIntent>,
  ): RebalanceIntent {
    const now = Date.now();
    return {
      id: 'intent-1',
      status: 'not_started',
      origin: ARBITRUM_DOMAIN,
      destination: SOLANA_DOMAIN,
      amount: 10000000000n,
      executionMethod: 'inventory',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  describe('Basic Inventory Rebalance (Sufficient Inventory)', () => {
    // NOTE: Strategy route is arbitrum (surplus) → solana (deficit)
    // But execution calls transferRemote FROM solana TO arbitrum (swapped direction)
    // This ADDS collateral to solana (filling deficit) and RELEASES from arbitrum (has surplus)

    it('executes transferRemote when inventory is available on destination chain', async () => {
      // Setup: Strategy says move from arbitrum→solana
      // We need inventory on SOLANA (destination/deficit) to call transferRemote FROM there
      const route = createTestRoute();
      const intent = createTestIntent();

      // Inventory is checked on DESTINATION (solana), not origin
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Single successful result
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(results[0].route).to.deep.equal(route);
      expect(results[0].intent).to.deep.equal(intent);

      // Verify: transferRemote was called via adapter
      expect(adapterStub.quoteTransferRemoteGas.calledOnce).to.be.true;
      expect(adapterStub.populateTransferRemoteTx.calledOnce).to.be.true;

      // Verify: Transaction was sent FROM SOLANA (destination chain, swapped)
      expect(multiProvider.sendTransaction.calledOnce).to.be.true;
      const [chainArg, txArg] = multiProvider.sendTransaction.firstCall.args;
      expect(chainArg).to.equal(SOLANA_CHAIN); // Called FROM destination (swapped)
      expect(txArg.to).to.equal('0xRouterAddress');

      // Verify: inventory_deposit action was created
      expect(actionTracker.createRebalanceAction.calledOnce).to.be.true;
      const actionParams =
        actionTracker.createRebalanceAction.firstCall.args[0];
      expect(actionParams.intentId).to.equal('intent-1');
      expect(actionParams.type).to.equal('inventory_deposit');
      expect(actionParams.amount).to.equal(10000000000n);
      expect(actionParams.txHash).to.equal('0xTransferRemoteTxHash');
    });

    it('executes transferRemote with correct parameters (swapped direction)', async () => {
      const route = createTestRoute({ amount: 5000000000n }); // 5k USDC
      const intent = createTestIntent({ amount: 5000000000n });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(5000000000n);

      await inventoryRebalancer.execute([route], [intent]);

      // Verify populateTransferRemoteTx params
      // Direction is SWAPPED: transferRemote from solana TO arbitrum
      const populateParams =
        adapterStub.populateTransferRemoteTx.firstCall.args[0];
      expect(populateParams.destination).to.equal(ARBITRUM_DOMAIN); // Goes TO arbitrum (swapped)
      expect(populateParams.recipient).to.equal(INVENTORY_SIGNER);
      expect(populateParams.weiAmountOrId).to.equal(5000000000n);
    });
  });

  describe('Partial Fulfillment (Insufficient Inventory)', () => {
    // MIN_INVENTORY_FOR_TRANSFER = 1e15 (0.001 ETH)
    // Test amounts must be above this threshold for partial execution
    const PARTIAL_AMOUNT = BigInt(5e15); // 0.005 ETH - above threshold
    const FULL_AMOUNT = BigInt(1e16); // 0.01 ETH

    it('executes partial transferRemote when inventory is less than required', async () => {
      // Setup: Need 0.01 ETH, but only 0.005 ETH available on DESTINATION (solana)
      // 0.005 ETH > MIN_INVENTORY_FOR_TRANSFER (0.001 ETH) so partial execution should work
      const route = createTestRoute({ amount: FULL_AMOUNT });
      const intent = createTestIntent({ amount: FULL_AMOUNT });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(PARTIAL_AMOUNT); // Only 0.005 ETH available

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Success with partial amount
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: transferRemote was called with available amount (0.005 ETH), not full amount (0.01 ETH)
      const populateParams =
        adapterStub.populateTransferRemoteTx.firstCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(PARTIAL_AMOUNT);

      // Verify: Action created for partial amount
      const actionParams =
        actionTracker.createRebalanceAction.firstCall.args[0];
      expect(actionParams.amount).to.equal(PARTIAL_AMOUNT);
    });

    it('intent remains in_progress after partial fulfillment', async () => {
      const route = createTestRoute({ amount: FULL_AMOUNT });
      const intent = createTestIntent({ amount: FULL_AMOUNT });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(PARTIAL_AMOUNT);

      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Intent is still returned (not completed)
      // The intent status will be updated by ActionTracker when action is created
      expect(results[0].intent.status).to.equal('not_started');
      // Note: In real flow, ActionTracker.createRebalanceAction transitions to 'in_progress'
    });
  });

  describe('No Inventory Available', () => {
    it('returns failure when no inventory on destination chain and no other source available', async () => {
      const route = createTestRoute();
      const intent = createTestIntent();

      // No inventory on DESTINATION (solana) - that's where we need it to call transferRemote
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Mock getBalances to return empty Map (no other chains with inventory)
      inventoryMonitor.getBalances.resolves(new Map());

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Failure result
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('No inventory available');

      // Verify: No transferRemote attempted
      expect(adapterStub.populateTransferRemoteTx.called).to.be.false;
      expect(multiProvider.sendTransaction.called).to.be.false;
      expect(actionTracker.createRebalanceAction.called).to.be.false;
    });
  });

  describe('Multiple Routes', () => {
    it('processes multiple routes independently', async () => {
      // Route 1: arbitrum → solana (check inventory on solana)
      const route1 = createTestRoute({ amount: 5000000000n });
      // Route 2: solana → arbitrum (check inventory on arbitrum)
      const route2 = createTestRoute({
        origin: SOLANA_CHAIN,
        destination: ARBITRUM_CHAIN,
        amount: 3000000000n,
      });

      const intent1 = createTestIntent({ id: 'intent-1', amount: 5000000000n });
      const intent2 = createTestIntent({
        id: 'intent-2',
        origin: SOLANA_DOMAIN,
        destination: ARBITRUM_DOMAIN,
        amount: 3000000000n,
      });

      // Inventory is checked on DESTINATION chain for each route:
      // Route 1 (arb→sol): check solana
      // Route 2 (sol→arb): check arbitrum
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(5000000000n);
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(3000000000n);

      // Execute
      const results = await inventoryRebalancer.execute(
        [route1, route2],
        [intent1, intent2],
      );

      // Verify: Both routes processed
      expect(results).to.have.lengthOf(2);
      expect(results[0].success).to.be.true;
      expect(results[1].success).to.be.true;

      // Verify: Two actions created
      expect(actionTracker.createRebalanceAction.calledTwice).to.be.true;
    });

    it('continues processing after route failure', async () => {
      // Both routes: arbitrum → solana (check inventory on solana)
      const route1 = createTestRoute({ amount: 5000000000n });
      const route2 = createTestRoute({ amount: 3000000000n });

      const intent1 = createTestIntent({ id: 'intent-1', amount: 5000000000n });
      const intent2 = createTestIntent({ id: 'intent-2', amount: 3000000000n });

      // Mock getBalances to return empty Map (no other chains with inventory for LiFi)
      inventoryMonitor.getBalances.resolves(new Map());

      // First route has no inventory on destination (solana), second has enough
      // Both check SOLANA (destination) but at different calls
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .onFirstCall()
        .resolves(0n) // First route: no inventory
        .onSecondCall()
        .resolves(3000000000n); // Second route: has inventory

      const results = await inventoryRebalancer.execute(
        [route1, route2],
        [intent1, intent2],
      );

      // Verify: First failed, second succeeded
      expect(results).to.have.lengthOf(2);
      expect(results[0].success).to.be.false;
      expect(results[1].success).to.be.true;
    });
  });

  describe('Error Handling', () => {
    it('handles transaction send failure', async () => {
      const route = createTestRoute();
      const intent = createTestIntent();

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);
      multiProvider.sendTransaction.rejects(new Error('Transaction failed'));

      const results = await inventoryRebalancer.execute([route], [intent]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Transaction failed');
    });

    it('handles missing token for chain', async () => {
      // Clear tokens to simulate missing token
      warpCore.tokens = [];

      const route = createTestRoute();
      const intent = createTestIntent();

      // Even with inventory, if no token for destination, it should fail
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      const results = await inventoryRebalancer.execute([route], [intent]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('No token found');
    });

    it('handles adapter quoteTransferRemoteGas failure', async () => {
      const route = createTestRoute();
      const intent = createTestIntent();

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);
      adapterStub.quoteTransferRemoteGas.rejects(new Error('Gas quote failed'));

      const results = await inventoryRebalancer.execute([route], [intent]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Gas quote failed');
    });

    it('handles missing intent for route', async () => {
      const route = createTestRoute();
      // No intent provided for this route

      const results = await inventoryRebalancer.execute([route], []);

      // Verify: Skipped due to no intent
      expect(results).to.have.lengthOf(0);
    });
  });

  describe('Native Token IGP Reservation', () => {
    // Gas estimation: 300,000 gas × 10 gwei = 3,000,000,000,000 wei
    // Buffered gas limit (10%): 330,000 gas
    // Buffered gas cost: 330,000 × 10 gwei = 3,300,000,000,000 wei
    // IGP quote: 1,000,000 wei
    // Total reservation: IGP + buffered gas = 3,300,001,000,000 wei (~0.0033 ETH)
    // Total cost (for min viable): IGP + buffered gas = 3,300,001,000,000 wei
    // Min viable transfer (2x total cost): 6,600,002,000,000 wei (~0.0066 ETH)
    const GAS_LIMIT = 300000n;
    const BUFFERED_GAS_LIMIT = (GAS_LIMIT * 110n) / 100n; // 10% buffer
    const GAS_PRICE = 10000000000n; // 10 gwei
    const BUFFERED_GAS_COST = GAS_PRICE * BUFFERED_GAS_LIMIT;
    const IGP_COST = 1000000n;
    const TOTAL_RESERVATION = IGP_COST + BUFFERED_GAS_COST;
    // Note: MIN_VIABLE_TRANSFER = TOTAL_COST * 2n = ~6.6e12 wei (~0.0066 ETH)

    it('reserves IGP and gas cost when transferring native tokens', async () => {
      // Setup: Native token on DESTINATION (solana) where IGP and gas must be reserved
      // Strategy: arbitrum → solana, so transferRemote is called FROM solana
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative, // Native token: reservation needed
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const requestedAmount = 10000000000000000n; // 0.01 ETH
      const availableInventory = requestedAmount + TOTAL_RESERVATION; // Enough for amount + costs

      const route = createTestRoute({ amount: requestedAmount });
      const intent = createTestIntent({ amount: requestedAmount });

      // Inventory on DESTINATION (solana) where transferRemote is called FROM
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableInventory);

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Success with full requested amount (since we have enough for amount + costs)
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: transferRemote was called with full amount (costs are separate)
      // Note: populateTransferRemoteTx is called multiple times:
      // - First calls: gas estimation with minimal amount (1n)
      // - Last call: actual transfer with requested amount
      const populateParams =
        adapterStub.populateTransferRemoteTx.lastCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(requestedAmount);
    });

    it('reduces transfer amount when inventory is limited', async () => {
      // Setup: Native token on DESTINATION where we have less inventory than needed
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      // Request more than we have available
      const requestedAmount = 20000000000000000n; // 0.02 ETH
      // Have enough for costs + partial transfer that exceeds min viable threshold
      // availableInventory = TOTAL_RESERVATION + partialAmount
      // where partialAmount >= MIN_VIABLE_TRANSFER (2x base cost)
      const partialAmount = 7000000000000000n; // 0.007 ETH (> MIN_VIABLE_TRANSFER of ~0.006 ETH)
      const availableInventory = TOTAL_RESERVATION + partialAmount;

      const route = createTestRoute({ amount: requestedAmount });
      const intent = createTestIntent({ amount: requestedAmount });

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableInventory);

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Success with reduced amount
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: transferRemote was called with reduced amount (inventory - costs)
      // Note: populateTransferRemoteTx is called multiple times:
      // - First in estimateTransferRemoteGas (for calculateMaxTransferable)
      // - Second in estimateTransferRemoteGas (for calculateMinViableTransfer)
      // - Third in executeTransferRemote (the actual transfer)
      // We check the last call which is the actual execution
      const populateParams =
        adapterStub.populateTransferRemoteTx.lastCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(partialAmount);
    });

    it('returns failure when inventory cannot cover costs', async () => {
      // Setup: Native token on DESTINATION where inventory is less than total reservation
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const route = createTestRoute({ amount: 10000000000000000n });
      const intent = createTestIntent({ amount: 10000000000000000n });

      // Available inventory on DESTINATION (solana) is less than total reservation (IGP + gas)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(TOTAL_RESERVATION - 1n); // Just under the threshold

      // Mock getBalances to return empty Map (no other chains with inventory)
      inventoryMonitor.getBalances.resolves(new Map());

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Failure due to insufficient funds
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('No inventory available');

      // Verify: No actual transferRemote executed (only gas estimation calls allowed)
      // Note: With gas estimation, populateTransferRemoteTx IS called for estimation,
      // so we can't check that it wasn't called at all. Instead, verify no action was created.
      expect(actionTracker.createRebalanceAction.called).to.be.false;
    });

    it('does not reserve IGP for non-native tokens', async () => {
      // Setup: Collateral tokens on both chains (IGP paid separately)
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypCollateral, // Non-native: no IGP reservation
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypCollateral, // Non-native: no IGP reservation
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const route = createTestRoute({ amount: 10000000000n });
      const intent = createTestIntent({ amount: 10000000000n });

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      // Execute
      const results = await inventoryRebalancer.execute([route], [intent]);

      // Verify: Success with full amount (no IGP deduction)
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      const populateParams =
        adapterStub.populateTransferRemoteTx.firstCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(10000000000n); // Full amount
    });
  });

  describe('getAvailableAmount', () => {
    it('returns available inventory when less than requested', async () => {
      const route = createTestRoute({ amount: 10000000000n });
      // Checks inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(5000000000n);

      const available = await inventoryRebalancer.getAvailableAmount(route);

      expect(available).to.equal(5000000000n);
    });

    it('returns requested amount when inventory is sufficient', async () => {
      const route = createTestRoute({ amount: 5000000000n });
      // Checks inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      const available = await inventoryRebalancer.getAvailableAmount(route);

      expect(available).to.equal(5000000000n);
    });

    it('returns zero when no inventory available', async () => {
      const route = createTestRoute({ amount: 10000000000n });
      // Checks inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      const available = await inventoryRebalancer.getAvailableAmount(route);

      expect(available).to.equal(0n);
    });
  });

  describe('LiFi Bridge Integration (for future inventory_movement)', () => {
    // These tests validate the mock utilities are working correctly
    // and prepare for when inventory_movement is implemented

    it('mock utilities create valid quote', () => {
      const quote = createMockBridgeQuote({
        fromAmount: 10000000000n,
        toAmount: 9950000000n,
      });

      expect(quote.id).to.equal('quote-123');
      expect(quote.tool).to.equal('across');
      expect(quote.fromAmount).to.equal(10000000000n);
      expect(quote.toAmount).to.equal(9950000000n);
    });

    it('bridge mock can be configured for quote', async () => {
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: 10000000000n,
          toAmount: 9950000000n,
        }),
      );

      const quote = await bridge.quote({
        fromChain: ARBITRUM_DOMAIN,
        toChain: SOLANA_DOMAIN,
        fromToken: '0xUSDC',
        toToken: '0xUSDC',
        fromAmount: 10000000000n,
        fromAddress: INVENTORY_SIGNER,
      });

      expect(quote.fromAmount).to.equal(10000000000n);
      expect(quote.toAmount).to.equal(9950000000n);
    });
  });
});
