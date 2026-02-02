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
      getTotalInventory: Sinon.stub(),
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
      getPartiallyFulfilledInventoryIntents: Sinon.stub(),
      createRebalanceAction: Sinon.stub(),
      completeRebalanceAction: Sinon.stub(),
      failRebalanceAction: Sinon.stub(),
      logStoreContents: Sinon.stub(),
    } as SinonStubbedInstance<IActionTracker>;

    // Default: No active (partial) inventory intents
    actionTracker.getPartiallyFulfilledInventoryIntents.resolves([]);

    bridge = {
      bridgeId: 'lifi',
      quote: Sinon.stub(),
      execute: Sinon.stub(),
      getStatus: Sinon.stub(),
      getNativeTokenAddress: Sinon.stub().returns(
        '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      ),
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
      addressOrDenom: '0xArbitrumToken',
      getHypAdapter: Sinon.stub().returns(adapterStub),
    };
    const solanaToken = {
      chainName: SOLANA_CHAIN,
      standard: TokenStandard.EvmHypCollateral, // Non-native: no IGP reservation needed
      addressOrDenom: '0xSolanaToken',
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
      getChainId: Sinon.stub().callsFake((chain: ChainName) => {
        if (chain === ARBITRUM_CHAIN) return 42161;
        if (chain === SOLANA_CHAIN) return 1399811149;
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
      getSigner: Sinon.stub().returns({
        getAddress: Sinon.stub().resolves(INVENTORY_SIGNER),
      }),
      sendTransaction: Sinon.stub().resolves({
        transactionHash: '0xTransferRemoteTxHash',
        logs: [], // Required for HyperlaneCore.getDispatchedMessages
      }),
    };

    // Default mock for getTotalInventory - returns very high value so tests default to full transfer
    // Individual tests can override this for specific scenarios
    inventoryMonitor.getTotalInventory.resolves(
      BigInt('1000000000000000000000'), // 1000 ETH - ensures amount <= totalInventory
    );

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
    const intent: RebalanceIntent = {
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

    // Configure mock to return this intent when createRebalanceIntent is called
    actionTracker.createRebalanceIntent.resolves(intent);

    return intent;
  }

  describe('Basic Inventory Rebalance (Sufficient Inventory)', () => {
    // NOTE: Strategy route is arbitrum (surplus) → solana (deficit)
    // But execution calls transferRemote FROM solana TO arbitrum (swapped direction)
    // This ADDS collateral to solana (filling deficit) and RELEASES from arbitrum (has surplus)

    it('executes transferRemote when inventory is available on destination chain', async () => {
      // Setup: Strategy says move from arbitrum→solana
      // We need inventory on SOLANA (destination/deficit) to call transferRemote FROM there
      const route = createTestRoute();
      const intent = createTestIntent(); // Configures mock to return intent

      // Inventory is checked on DESTINATION (solana), not origin
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      // Execute
      const results = await inventoryRebalancer.execute([route]);

      // Verify: Single successful result
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(results[0].route).to.deep.equal(route);
      expect(results[0].intent.id).to.equal(intent.id);

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
      createTestIntent({ amount: 5000000000n });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(5000000000n);

      await inventoryRebalancer.execute([route]);

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
    // Partial transfers happen when maxTransferable >= minViableTransfer
    // For non-native tokens (EvmHypCollateral), minViableTransfer = 0, so partial always viable
    const PARTIAL_AMOUNT = BigInt(5e15); // 0.005 ETH - above threshold
    const FULL_AMOUNT = BigInt(1e16); // 0.01 ETH

    it('executes partial transferRemote when maxTransferable >= minViableTransfer', async () => {
      // Setup: Need 0.01 ETH, but only 0.005 ETH available on destination
      // For non-native tokens, minViableTransfer = 0, so partial transfer is viable
      const route = createTestRoute({ amount: FULL_AMOUNT });
      createTestIntent({ amount: FULL_AMOUNT });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(PARTIAL_AMOUNT); // Only 0.005 ETH available

      // Total inventory for logging
      inventoryMonitor.getTotalInventory.resolves(PARTIAL_AMOUNT);

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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
      createTestIntent({ amount: FULL_AMOUNT });

      // Inventory checked on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(PARTIAL_AMOUNT);

      // Total inventory (excluding origin) = 0.005 ETH
      inventoryMonitor.getTotalInventory.resolves(PARTIAL_AMOUNT);

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Intent is still returned (not completed)
      // The intent status will be updated by ActionTracker when action is created
      expect(results[0].intent.status).to.equal('not_started');
      // Note: In real flow, ActionTracker.createRebalanceAction transitions to 'in_progress'
    });
  });

  describe('No Inventory Available', () => {
    it('returns failure when no inventory on destination chain and no other source available', async () => {
      const route = createTestRoute();
      createTestIntent();

      // No inventory on DESTINATION (solana) - that's where we need it to call transferRemote
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Mock getBalances to return empty Map (no other chains with inventory)
      inventoryMonitor.getBalances.resolves(new Map());

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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

  describe('Single Intent Architecture', () => {
    it('takes only first route when multiple routes provided', async () => {
      // Route 1: arbitrum → solana (check inventory on solana)
      const route1 = createTestRoute({ amount: 5000000000n });
      // Route 2: solana → arbitrum (would check inventory on arbitrum if processed)
      const route2 = createTestRoute({
        origin: SOLANA_CHAIN,
        destination: ARBITRUM_CHAIN,
        amount: 3000000000n,
      });

      createTestIntent({ id: 'intent-1', amount: 5000000000n });

      // Inventory on DESTINATION of first route (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(5000000000n);

      // Execute with multiple routes
      const results = await inventoryRebalancer.execute([route1, route2]);

      // Verify: Only ONE route processed (single-intent architecture)
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: Only one intent created
      expect(actionTracker.createRebalanceIntent.calledOnce).to.be.true;

      // Verify: Only one action created
      expect(actionTracker.createRebalanceAction.calledOnce).to.be.true;
    });

    it('continues existing intent instead of processing new routes', async () => {
      // Setup: existing partial intent
      const existingIntent = createTestIntent({
        id: 'existing-intent',
        status: 'in_progress',
        amount: 10000000000n,
      });

      // Configure mock to return existing partial intent
      actionTracker.getPartiallyFulfilledInventoryIntents.resolves([
        {
          intent: existingIntent,
          completedAmount: 3000000000n,
          remaining: 7000000000n, // 7k remaining
        },
      ]);

      // New route that would be ignored
      const newRoute = createTestRoute({ amount: 5000000000n });

      // Inventory on DESTINATION of existing intent (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n); // Plenty of inventory

      // Execute with new route (should be ignored in favor of existing intent)
      const results = await inventoryRebalancer.execute([newRoute]);

      // Verify: Existing intent was continued (not new route)
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(results[0].intent.id).to.equal('existing-intent');

      // Verify: No new intent was created
      expect(actionTracker.createRebalanceIntent.called).to.be.false;
    });

    it('returns empty results when no routes provided and no active intent', async () => {
      const results = await inventoryRebalancer.execute([]);

      expect(results).to.have.lengthOf(0);
      expect(actionTracker.createRebalanceIntent.called).to.be.false;
    });

    it('continues existing not_started intent instead of creating new one', async () => {
      // Setup: Create an intent that stays 'not_started' (simulating failed bridges)
      const existingIntent = createTestIntent({
        id: 'stuck-not-started-intent',
        status: 'not_started', // Never transitioned to in_progress
        amount: 10000000000n,
      });

      // Configure mock to return the not_started intent as a partial intent
      // (this is the fix - getPartiallyFulfilledInventoryIntents now includes not_started)
      actionTracker.getPartiallyFulfilledInventoryIntents.resolves([
        {
          intent: existingIntent,
          completedAmount: 0n,
          remaining: 10000000000n,
        },
      ]);

      // New route that would be ignored in favor of existing intent
      const newRoute = createTestRoute({ amount: 5000000000n });

      // Provide sufficient inventory for execution
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      const results = await inventoryRebalancer.execute([newRoute]);

      // Verify: Existing not_started intent was continued (not new route)
      expect(results).to.have.lengthOf(1);
      expect(results[0].intent.id).to.equal('stuck-not-started-intent');

      // Verify: No new intent was created
      expect(actionTracker.createRebalanceIntent.called).to.be.false;
    });
  });

  describe('Error Handling', () => {
    it('handles transaction send failure', async () => {
      const route = createTestRoute();
      createTestIntent();

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);
      multiProvider.sendTransaction.rejects(new Error('Transaction failed'));

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Transaction failed');
    });

    it('handles missing token for chain', async () => {
      // Clear tokens to simulate missing token
      warpCore.tokens = [];

      const route = createTestRoute();
      createTestIntent();

      // Even with inventory, if no token for destination, it should fail
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('No token found');
    });

    it('handles adapter quoteTransferRemoteGas failure', async () => {
      const route = createTestRoute();
      createTestIntent();

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);
      adapterStub.quoteTransferRemoteGas.rejects(new Error('Gas quote failed'));

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Gas quote failed');
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
      createTestIntent({ amount: requestedAmount });

      // Inventory on DESTINATION (solana) where transferRemote is called FROM
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableInventory);

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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
      createTestIntent({ amount: requestedAmount });

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableInventory);

      // For partial transfer to happen with 50% threshold logic:
      // - amount > totalInventory (so looping is required)
      // - maxTransferable >= 50% of totalInventory
      // Here: totalInventory = partialAmount (same as what's on destination)
      // Since 100% is consolidated on destination, partial transfer should happen
      inventoryMonitor.getTotalInventory.resolves(partialAmount);

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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
      createTestIntent({ amount: 10000000000000000n });

      // Available inventory on DESTINATION (solana) is less than total reservation (IGP + gas)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(TOTAL_RESERVATION - 1n); // Just under the threshold

      // Mock getBalances to return empty Map (no other chains with inventory)
      inventoryMonitor.getBalances.resolves(new Map());

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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
      createTestIntent({ amount: 10000000000n });

      // Inventory on DESTINATION (solana)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(10000000000n);

      // Execute
      const results = await inventoryRebalancer.execute([route]);

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

  describe('Smart Partial Transfer Threshold', () => {
    // Test the 90% consolidation threshold for partial transfers
    // Tests use non-native tokens (EvmHypCollateral) so minViableTransfer = 0

    it('does partial transfer when inventory is available on destination', async () => {
      // amount = 1 ETH, availableOnDestination = 0.5 ETH
      // With simplified logic: if maxTransferable >= minViableTransfer, do partial transfer
      // For non-native tokens, minViableTransfer = 0, so partial transfer happens
      const amount = BigInt(1e18); // 1 ETH
      const availableOnDestination = BigInt(0.5e18); // 0.5 ETH on destination

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Inventory on destination (SOLANA)
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableOnDestination);

      inventoryMonitor.getTotalInventory.resolves(availableOnDestination);

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: transferRemote WAS called (partial transfer happened)
      const populateParams =
        adapterStub.populateTransferRemoteTx.lastCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(availableOnDestination);

      // Verify: Bridge was NOT called (no need to bridge when partial transfer is viable)
      expect(bridge.execute.called).to.be.false;
    });

    it('does partial transfer when maxTransferable >= minViableTransfer', async () => {
      // For non-native tokens (EvmHypCollateral), minViableTransfer = 0
      // So any positive maxTransferable triggers partial transfer
      const amount = BigInt(2e18); // 2 ETH requested
      const maxTransferable = BigInt(0.6e18); // 0.6 ETH available

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // 0.6 ETH available on destination
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(maxTransferable);

      inventoryMonitor.getTotalInventory.resolves(maxTransferable);

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: transferRemote WAS called with partial amount
      const populateParams =
        adapterStub.populateTransferRemoteTx.lastCall.args[0];
      expect(populateParams.weiAmountOrId).to.equal(maxTransferable);
    });

    it('does NOT do partial transfer when maxTransferable < minViableTransfer (native tokens)', async () => {
      // For native tokens (EvmHypNative), minViableTransfer = totalCost * 2
      // When available inventory minus costs is below minViableTransfer, falls through to bridging
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

      const amount = BigInt(2e18); // 2 ETH
      // Available inventory is small - after subtracting costs, maxTransferable < minViableTransfer
      // minViableTransfer = ~0.0066 ETH (totalCost * 2)
      // If available = 0.005 ETH, after costs ~0, maxTransferable < minViableTransfer
      const availableOnDestination = BigInt(0.003e18); // 0.003 ETH - below minViableTransfer
      const availableOnSource = BigInt(0.6e18); // 0.6 ETH on ARBITRUM

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Inventory on destination - too small after costs
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(availableOnDestination);

      // Inventory on source - needed for executeInventoryMovement
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(availableOnSource);

      inventoryMonitor.getTotalInventory.resolves(
        availableOnDestination + availableOnSource,
      );

      // Mock getBalances to provide sources for bridging
      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: availableOnSource,
              available: availableOnSource,
            },
          ],
          [
            SOLANA_CHAIN,
            {
              chainName: SOLANA_CHAIN,
              balance: availableOnDestination,
              available: availableOnDestination,
            },
          ],
        ]),
      );

      // Mock bridge
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(0.5e18),
          toAmount: BigInt(0.48e18),
        }),
      );
      bridge.execute.resolves({
        txHash: '0xBridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: inventory movement via bridge happened (NOT partial transferRemote)
      expect(bridge.execute.called).to.be.true;
    });
  });

  describe('Early Exit for Small Amounts', () => {
    // Gas estimation: 300,000 gas × 10 gwei = 3,000,000,000,000 wei
    // Buffered gas limit (10%): 330,000 gas
    // Buffered gas cost: 330,000 × 10 gwei = 3,300,000,000,000 wei
    // IGP quote: 1,000,000 wei
    // Total cost: IGP + buffered gas = 3,300,001,000,000 wei (~0.0033 ETH)
    // Min viable transfer (2x total cost): ~0.0066 ETH
    const MIN_VIABLE = BigInt(6.6e12); // ~0.0066 ETH

    it('completes intent when amount < minViableTransfer', async () => {
      // Use native token to get non-zero minViableTransfer
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

      // Amount smaller than minViableTransfer
      const smallAmount = MIN_VIABLE / 2n; // 0.0033 ETH < minViable 0.0066 ETH
      const route = createTestRoute({ amount: smallAmount });
      createTestIntent({ amount: smallAmount });

      // Even with plenty of inventory, small amount triggers early exit
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(BigInt(10e18)); // 10 ETH available

      inventoryMonitor.getTotalInventory.resolves(BigInt(10e18));

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect((results[0] as any).reason).to.equal(
        'completed_with_acceptable_loss',
      );

      // Verify: Intent was completed (not left in progress)
      expect(actionTracker.completeRebalanceIntent.calledOnce).to.be.true;
      expect(actionTracker.completeRebalanceIntent.calledWith('intent-1')).to.be
        .true;

      // Verify: No transferRemote was attempted
      expect(actionTracker.createRebalanceAction.called).to.be.false;
    });
  });

  describe('Parallel Multi-Source Bridging', () => {
    // Third chain for multi-source tests
    const BASE_CHAIN = 'base' as ChainName;
    const BASE_DOMAIN = 8453;

    beforeEach(() => {
      // Extend multiProvider to handle BASE_CHAIN
      multiProvider.getDomainId.callsFake((chain: ChainName) => {
        if (chain === ARBITRUM_CHAIN) return ARBITRUM_DOMAIN;
        if (chain === SOLANA_CHAIN) return SOLANA_DOMAIN;
        if (chain === BASE_CHAIN) return BASE_DOMAIN;
        return 0;
      });

      multiProvider.getChainId = Sinon.stub().callsFake((chain: ChainName) => {
        if (chain === ARBITRUM_CHAIN) return 42161;
        if (chain === SOLANA_CHAIN) return 1399811149;
        if (chain === BASE_CHAIN) return 8453;
        return 0;
      });

      // Add token for BASE_CHAIN
      const baseToken = {
        chainName: BASE_CHAIN,
        standard: TokenStandard.EvmHypCollateral,
        getHypAdapter: Sinon.stub().returns(adapterStub),
        addressOrDenom: '0xBaseToken',
      };
      warpCore.tokens.push(baseToken);

      // Mock getSigner for bridge execution
      const mockSigner = {
        getAddress: Sinon.stub().resolves(INVENTORY_SIGNER),
      };
      multiProvider.getSigner = Sinon.stub().returns(mockSigner);
    });

    it('bridges from multiple sources in parallel', async () => {
      // Need 1 ETH on solana, have 0.6 ETH on arbitrum and 0.6 ETH on base
      const amount = BigInt(1e18);
      const perChainInventory = BigInt(0.6e18);

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // No inventory on destination
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Inventory on sources - needed for executeInventoryMovement
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(perChainInventory);
      inventoryMonitor.getAvailableInventory
        .withArgs(BASE_CHAIN)
        .resolves(perChainInventory);

      // Low total inventory to trigger bridging
      inventoryMonitor.getTotalInventory.resolves(BigInt(1.2e18));

      // Two source chains with inventory
      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            BASE_CHAIN,
            {
              chainName: BASE_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Mock bridge quotes and execution
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(0.55e18),
          toAmount: BigInt(0.525e18),
        }),
      );
      bridge.execute.resolves({
        txHash: '0xBridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      const results = await inventoryRebalancer.execute([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: Bridge was called twice (once for each source)
      expect(bridge.execute.callCount).to.equal(2);
    });

    it('applies 5% buffer to total bridge amount', async () => {
      // Need 1 ETH -> should plan to bridge 1.05 ETH total (with 5% buffer)
      const amount = BigInt(1e18); // 1 ETH
      const availableInventory = BigInt(2e18); // 2 ETH on source

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // No inventory on destination
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Inventory on source - needed for executeInventoryMovement
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(availableInventory);

      inventoryMonitor.getTotalInventory.resolves(availableInventory);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: availableInventory,
              available: availableInventory,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Capture the quote amount from executeInventoryMovement
      // (calculateMaxViableBridgeAmount doesn't quote for ERC20 tokens)
      let quotedFromAmount: bigint | undefined;
      bridge.quote.callsFake(async (params: any) => {
        quotedFromAmount = params.fromAmount;
        return createMockBridgeQuote({
          fromAmount: params.fromAmount ?? params.toAmount,
          toAmount: params.fromAmount ?? params.toAmount,
        });
      });
      bridge.execute.resolves({
        txHash: '0xBridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      await inventoryRebalancer.execute([route]);

      // Verify: 5% buffer applied (1 ETH * 1.05 = 1.05 ETH)
      // The bridge plan uses pre-validated amounts (for ERC20, full inventory available)
      // But the target is (amount * 105%), so if source has >= target, we bridge exactly target
      const expectedWithBuffer = (amount * 105n) / 100n;
      expect(quotedFromAmount).to.equal(expectedWithBuffer);
    });

    it('continues when some bridges fail', async () => {
      const amount = BigInt(1e18);
      const perChainInventory = BigInt(0.6e18);

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // No inventory on destination
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Inventory on sources - needed for executeInventoryMovement
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(perChainInventory);
      inventoryMonitor.getAvailableInventory
        .withArgs(BASE_CHAIN)
        .resolves(perChainInventory);

      inventoryMonitor.getTotalInventory.resolves(BigInt(1.2e18));

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            BASE_CHAIN,
            {
              chainName: BASE_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(0.55e18),
          toAmount: BigInt(0.525e18),
        }),
      );

      // First bridge succeeds, second fails
      bridge.execute
        .onFirstCall()
        .resolves({
          txHash: '0xSuccessTxHash',
          fromChain: 42161,
          toChain: 1399811149,
        })
        .onSecondCall()
        .rejects(new Error('Bridge execution failed'));

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Overall success (at least one bridge succeeded)
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
    });

    it('returns failure when all bridges fail', async () => {
      const amount = BigInt(1e18);
      const perChainInventory = BigInt(0.6e18);

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // No inventory on destination
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Inventory on sources - needed for executeInventoryMovement
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(perChainInventory);
      inventoryMonitor.getAvailableInventory
        .withArgs(BASE_CHAIN)
        .resolves(perChainInventory);

      inventoryMonitor.getTotalInventory.resolves(BigInt(1.2e18));

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            BASE_CHAIN,
            {
              chainName: BASE_CHAIN,
              balance: perChainInventory,
              available: perChainInventory,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(0.55e18),
          toAmount: BigInt(0.525e18),
        }),
      );

      // All bridges fail
      bridge.execute.rejects(new Error('Bridge execution failed'));

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Failure when all bridges fail
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('All inventory movements failed');
    });
  });

  describe('Bridge Viability Check', () => {
    // Tests for the gas-aware planning approach that prevents "insufficient funds for gas * price + value" errors
    // by calculating max viable bridge amounts BEFORE creating bridge plans.
    // Uses calculateMaxViableBridgeAmount which:
    // 1. Gets a quote to determine gas costs
    // 2. Applies 20x multiplier on quoted gas (LiFi underestimates)
    // 3. Returns 0 if gas exceeds 10% of inventory (not economically viable)

    it('filters out sources where gas cost exceeds 10% of inventory', async () => {
      // Setup: Native token bridge where gas cost is too high relative to balance
      // Scenario: Arbitrum has 0.00219 ETH, estimated gas (with 20x buffer) exceeds 10% threshold
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative, // Native token for gas check
        addressOrDenom: '0xArbitrumNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xSolanaNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const amount = BigInt(1e18); // 1 ETH requested on destination

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Raw balance on source chain (ARBITRUM) - the limiting factor
      const rawBalance = BigInt('2194632084196208'); // ~0.00219 ETH

      // No inventory on destination - triggers bridge from ARBITRUM
      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);

      // Inventory on source - raw balance that's too low
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(rawBalance);

      inventoryMonitor.getTotalInventory.resolves(rawBalance);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: rawBalance,
              available: rawBalance,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Mock quote with gas costs that exceed 10% threshold when multiplied by 20
      // rawBalance = 0.00219 ETH
      // 10% threshold = 0.000219 ETH
      // gasCosts = 0.00005 ETH, estimated = 0.001 ETH (20x multiplier)
      // 0.001 > 0.000219 → not viable
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: rawBalance,
          toAmount: rawBalance - BigInt(1e14), // Some output
          gasCosts: BigInt('50000000000000'), // 0.00005 ETH, becomes 0.001 ETH with 20x
          feeCosts: 0n,
        }),
      );

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Should fail because no sources pass viability check at planning time
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      // New behavior: Error is "No viable bridge sources" (filtered at planning time)
      // rather than "Insufficient funds" (which was at execution time)
      expect(results[0].error).to.include('No viable bridge sources');

      // Verify: Bridge.execute should NOT have been called (filtered during planning)
      expect(bridge.execute.called).to.be.false;
    });

    it('proceeds with bridge when total cost is within available balance', async () => {
      // Setup: Native token bridge where we have enough balance
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xArbitrumNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xSolanaNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const amount = BigInt(1e18); // 1 ETH requested

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Plenty of balance on source chain
      const rawBalance = BigInt(2e18); // 2 ETH - more than enough

      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(rawBalance);

      inventoryMonitor.getTotalInventory.resolves(rawBalance);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: rawBalance,
              available: rawBalance,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Quote with reasonable costs well under the balance
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(1.05e18), // 1.05 ETH (with buffer)
          toAmount: BigInt(1e18),
          gasCosts: BigInt(1e15), // 0.001 ETH gas
          feeCosts: 0n,
        }),
      );

      // Mock successful execution
      bridge.execute.resolves({
        txHash: '0xSuccessBridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Should succeed
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;

      // Verify: Bridge.execute WAS called (not abandoned)
      expect(bridge.execute.calledOnce).to.be.true;
    });

    it('viability check only applies to native tokens (not ERC20)', async () => {
      // Setup: ERC20 token bridge - gas is paid separately in ETH, not from token balance
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypCollateral, // ERC20, not native
        addressOrDenom: '0xArbitrumToken',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypCollateral,
        addressOrDenom: '0xSolanaToken',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const amount = BigInt(1e18); // 1 token
      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Small token balance (but gas is paid in ETH, so this shouldn't matter for viability)
      const tokenBalance = BigInt(1e18);

      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(tokenBalance);

      inventoryMonitor.getTotalInventory.resolves(tokenBalance);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: tokenBalance,
              available: tokenBalance,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Quote with high gas costs (but for ERC20, this shouldn't trigger viability check)
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: BigInt(1.05e18),
          toAmount: BigInt(1e18),
          gasCosts: BigInt(1e18), // Very high gas (would fail viability if this were native)
          feeCosts: 0n,
        }),
      );

      bridge.execute.resolves({
        txHash: '0xERC20BridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Should succeed because ERC20 viability check doesn't include gasCosts
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(bridge.execute.calledOnce).to.be.true;
    });

    it('calculates max viable amount as inventory minus (gasCosts * 20) for native tokens', async () => {
      // Setup: Native token with enough balance for viable bridge
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xArbitrumNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xSolanaNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const amount = BigInt(0.5e18); // 0.5 ETH requested

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      // Large balance - should be viable
      const rawBalance = BigInt(1e18); // 1 ETH

      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(rawBalance);

      inventoryMonitor.getTotalInventory.resolves(rawBalance);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: rawBalance,
              available: rawBalance,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // gasCosts = 0.001 ETH, estimated = 0.02 ETH (20x multiplier)
      // maxViable = 1 ETH - 0.02 ETH = 0.98 ETH
      // 10% threshold = 0.1 ETH, estimatedGas (0.02) < threshold → viable
      const gasCosts = BigInt(0.001e18); // 0.001 ETH
      bridge.quote.resolves(
        createMockBridgeQuote({
          fromAmount: rawBalance,
          toAmount: rawBalance - BigInt(1e15),
          gasCosts,
          feeCosts: 0n,
        }),
      );

      bridge.execute.resolves({
        txHash: '0xSuccessBridgeTxHash',
        fromChain: 42161,
        toChain: 1399811149,
      });

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Should succeed - bridge is viable
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(bridge.execute.calledOnce).to.be.true;

      // Verify: The quoted fromAmount should be the target (since maxViable > target)
      // For the execution quote (second quote call):
      // targetWithBuffer = (0.5 ETH) * 1.05 = 0.525 ETH (for non-inventory execution, costs are 0)
      const executionQuoteCall = bridge.quote
        .getCalls()
        .find(
          (call: any) =>
            call.args[0].fromAmount !== undefined &&
            call.args[0].fromAmount !== rawBalance,
        );
      // Since maxViable (0.98 ETH) > targetWithBuffer (0.525 ETH), we bridge exactly targetWithBuffer
      expect(executionQuoteCall).to.exist;
    });

    it('handles quote failures gracefully by skipping the source chain', async () => {
      // Setup: Native token where quote fails
      const arbitrumToken = {
        chainName: ARBITRUM_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xArbitrumNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      const solanaToken = {
        chainName: SOLANA_CHAIN,
        standard: TokenStandard.EvmHypNative,
        addressOrDenom: '0xSolanaNative',
        getHypAdapter: Sinon.stub().returns(adapterStub),
      };
      warpCore.tokens = [arbitrumToken, solanaToken];

      const amount = BigInt(1e18);

      const route = createTestRoute({ amount });
      createTestIntent({ amount });

      const rawBalance = BigInt(2e18); // 2 ETH

      inventoryMonitor.getAvailableInventory
        .withArgs(SOLANA_CHAIN)
        .resolves(0n);
      inventoryMonitor.getAvailableInventory
        .withArgs(ARBITRUM_CHAIN)
        .resolves(rawBalance);

      inventoryMonitor.getTotalInventory.resolves(rawBalance);

      inventoryMonitor.getBalances.resolves(
        new Map([
          [
            ARBITRUM_CHAIN,
            {
              chainName: ARBITRUM_CHAIN,
              balance: rawBalance,
              available: rawBalance,
            },
          ],
          [
            SOLANA_CHAIN,
            { chainName: SOLANA_CHAIN, balance: 0n, available: 0n },
          ],
        ]),
      );

      // Quote fails for viability check
      bridge.quote.rejects(new Error('LiFi API timeout'));

      const results = await inventoryRebalancer.execute([route]);

      // Verify: Should fail because quote error means no viable sources
      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('No viable bridge sources');

      // Verify: Bridge.execute should NOT have been called
      expect(bridge.execute.called).to.be.false;
    });
  });
});
