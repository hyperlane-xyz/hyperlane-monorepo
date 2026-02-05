import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '../config/types.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  DOMAIN_IDS,
  FORK_BLOCK_NUMBERS,
  TEST_CHAINS,
  USDC_ADDRESSES,
  USDC_INCENTIV_WARP_ROUTE,
  USDC_SUPERSEED_WARP_ROUTE,
} from './fixtures/routes.js';
import { getAllCollateralBalances } from './harness/BridgeSetup.js';
import { ForkManager } from './harness/ForkManager.js';
import { setupTrustedRelayerIsmForRoute } from './harness/IsmUpdater.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

const MIN_AMOUNT_STRATEGY_CONFIG = [
  {
    rebalanceStrategy: RebalancerStrategyOptions.MinAmount as const,
    chains: {
      ethereum: {
        minAmount: {
          min: '100',
          target: '120',
          type: RebalancerMinAmountType.Absolute,
        },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
      },
      arbitrum: {
        minAmount: {
          min: '100',
          target: '120',
          type: RebalancerMinAmountType.Absolute,
        },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
      },
      base: {
        minAmount: {
          min: '100',
          target: '120',
          type: RebalancerMinAmountType.Absolute,
        },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
      },
    },
  },
];

describe('MinAmountStrategy E2E', function () {
  this.timeout(300_000);

  let forkManager: ForkManager;
  let multiProvider: MultiProvider;
  let forkedProviders: Map<string, providers.JsonRpcProvider>;
  let registry: GithubRegistry;
  let userAddress: string;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;

  before(async function () {
    const wallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    userAddress = wallet.address;

    registry = new GithubRegistry();
    const chainMetadata = await registry.getMetadata();
    const testChainMetadata: Record<string, ChainMetadata> = {};

    for (const chain of TEST_CHAINS) {
      if (chainMetadata[chain]) {
        testChainMetadata[chain] = chainMetadata[chain];
      }
    }

    const baseMultiProvider = new MultiProvider(testChainMetadata);
    for (const chain of TEST_CHAINS) {
      baseMultiProvider.setSigner(chain, wallet);
    }

    forkManager = new ForkManager({
      chains: TEST_CHAINS,
      registry,
      multiProvider: baseMultiProvider,
      blockNumbers: FORK_BLOCK_NUMBERS,
    });

    const forkContext = await forkManager.start();
    multiProvider = forkContext.multiProvider;
    forkedProviders = forkContext.providers;

    const allCoreAddresses = await registry.getAddresses();
    const knownChains = new Set(multiProvider.getKnownChainNames());
    const coreAddresses = Object.fromEntries(
      Object.entries(allCoreAddresses).filter(([chain]) =>
        knownChains.has(chain),
      ),
    );
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    // Set up TrustedRelayerIsm on routers so we can relay without validator signatures
    const mailboxesByChain: Record<string, string> = {};
    for (const chain of TEST_CHAINS) {
      const addr = allCoreAddresses[chain]?.mailbox;
      if (addr) mailboxesByChain[chain] = addr;
    }
    // Set up ISM on monitored route (for user transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      mailboxesByChain,
      userAddress,
    );
    // Set up ISM on bridge route (for rebalance transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_SUPERSEED_WARP_ROUTE.routers,
      mailboxesByChain,
      userAddress,
    );

    snapshotIds = new Map();
    for (const [chain, provider] of forkedProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    for (const [chain, provider] of forkedProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      // Fresh snapshot required: Anvil invalidates the snapshot after revert
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  after(async function () {
    if (forkManager) {
      await forkManager.stop();
    }
  });

  it('should propose rebalance routes when chain is below minimum', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(MIN_AMOUNT_STRATEGY_CONFIG)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: ethereum→arbitrum, amount=70 USDC to reach 120 target from 50
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].origin).to.equal(DOMAIN_IDS.ethereum);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.arbitrum);
    expect(activeIntents[0].amount).to.equal(70000000n);
  });

  it('should not propose routes when all chains at or above minimum', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(MIN_AMOUNT_STRATEGY_CONFIG)
      .withBalances('BALANCED')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: No routes - all chains have 5000 USDC, well above 100 min
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(0);
  });

  it('should execute full rebalance cycle with actual transfers', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(MIN_AMOUNT_STRATEGY_CONFIG)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const initialCollateralBalances = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Assert: Rebalance intent was created with correct fields
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.arbitrum);
    expect(activeIntents[0].amount).to.equal(70000000n);

    // Assert: Rebalance action was created
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);

    const actionToArbitrum = inProgressActions[0];
    expect(actionToArbitrum.destination).to.equal(DOMAIN_IDS.arbitrum);
    expect(actionToArbitrum.amount).to.equal(70000000n);

    // Assert: Monitored route collateral on origin DECREASED (sent to bridge)
    const balancesAfterRebalance = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    // Assert: ethereum balance decreased by 70 USDC
    const expectedDecrease = BigNumber.from(70000000);
    expect(
      initialCollateralBalances.ethereum.sub(expectedDecrease).toString(),
    ).to.equal(balancesAfterRebalance.ethereum.toString());

    // Relay the rebalance message to destination
    const ethProvider = forkedProviders.get('ethereum')!;
    const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
      actionToArbitrum.txHash!,
    );
    const rebalanceRelayResult = await tryRelayMessage(
      multiProvider,
      hyperlaneCore,
      {
        dispatchTx: rebalanceTxReceipt,
        messageId: actionToArbitrum.messageId,
        origin: 'ethereum',
        destination: 'arbitrum',
      },
    );
    expect(
      rebalanceRelayResult.success,
      `Rebalance relay should succeed: ${rebalanceRelayResult.error}`,
    ).to.be.true;

    // Sync actions to detect delivery and mark complete
    await context.tracker.syncRebalanceActions();

    // Assert: Action is now complete
    const completedAction = await context.tracker.getRebalanceAction(
      actionToArbitrum.id,
    );
    expect(completedAction!.status).to.equal('complete');

    // Assert: Intent is now complete
    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');
    expect(completedIntent!.fulfilledAmount).to.equal(70000000n);
  });

  it('should handle stuck transfer and propose routes to destination', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(MIN_AMOUNT_STRATEGY_CONFIG)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute to create inflight eth→arb =====
    // Initial: eth=6000, arb=50 (below 100 min), base=4000
    // MinAmount will trigger: arb needs 100, so propose ~70 USDC from eth
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags1 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags1);
    await context.tracker.syncRebalanceActions(blockTags1);

    const inProgress = await context.tracker.getInProgressActions();
    expect(
      inProgress.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToArb = inProgress.find(
      (a) =>
        a.destination === DOMAIN_IDS.arbitrum &&
        a.origin === DOMAIN_IDS.ethereum,
    );
    expect(inflightToArb, 'Should have inflight action eth→arb').to.exist;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Strategy sees: arb effective = 50 + inflight ≈ 120 (target)
    // Should propose reduced amount or nothing to arb (within tolerance)
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const blockTags = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags);
    await context.tracker.syncRebalanceActions(blockTags);

    // Check if new routes to arb were proposed
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToArb = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.arbitrum &&
        a.id !== inflightToArb!.id &&
        a.status === 'in_progress',
    );

    if (newActionsToArb.length > 0) {
      // If route was proposed, should be much smaller than original ~70 USDC
      const proposedAmount = BigNumber.from(
        newActionsToArb[0].amount,
      ).toBigInt();
      expect(
        proposedAmount < 50000000n,
        `Amount to arb (${proposedAmount}) should be reduced accounting for inflight`,
      ).to.be.true;
    }
    // If no new route to arb, that's valid (within tolerance after inflight)

    // Verify inflight still exists and action tracking is working
    const finalInProgress = await context.tracker.getInProgressActions();
    const inflightStillActive = finalInProgress.find(
      (a) => a.id === inflightToArb!.id,
    );
    expect(inflightStillActive, 'Inflight action should still be tracked').to
      .exist;
    expect(inflightStillActive!.status).to.equal('in_progress');
  });
});
