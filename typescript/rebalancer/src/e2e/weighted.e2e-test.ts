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

import { RebalancerStrategyOptions } from '../config/types.js';
import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';
import type { Monitor } from '../monitor/Monitor.js';

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
import { TestRebalancer } from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

async function getFirstMonitorEvent(monitor: Monitor): Promise<MonitorEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Monitor event timeout'));
    }, 60_000);

    monitor.on(MonitorEventType.TokenInfo, (event: MonitorEvent) => {
      clearTimeout(timeout);
      void monitor.stop();
      resolve(event);
    });

    monitor.on(MonitorEventType.Error, (error: Error) => {
      clearTimeout(timeout);
      void monitor.stop();
      reject(error);
    });

    void monitor.start();
  });
}

const WEIGHTED_STRATEGY_CONFIG = [
  {
    rebalanceStrategy: RebalancerStrategyOptions.Weighted as const,
    chains: {
      ethereum: {
        weighted: { weight: 60n, tolerance: 5n },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
      },
      arbitrum: {
        weighted: { weight: 20n, tolerance: 5n },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
      },
      base: {
        weighted: { weight: 20n, tolerance: 5n },
        bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
      },
    },
  },
];

describe('WeightedStrategy E2E', function () {
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

  it('should propose rebalance routes when weights are unbalanced', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(WEIGHTED_STRATEGY_CONFIG)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('propose')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    const cycleResult = await context.orchestrator.executeCycle(event);

    // Assert: Strategy proposed routes for the imbalanced chain
    expect(cycleResult.proposedRoutes.length).to.equal(1);
    expect(cycleResult.proposedRoutes[0].origin).to.equal('ethereum');
    expect(cycleResult.proposedRoutes[0].destination).to.equal('base');
    expect(cycleResult.proposedRoutes[0].amount).to.equal(1000000000n);
  });

  it('should not propose routes when within tolerance', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(WEIGHTED_STRATEGY_CONFIG)
      .withBalances('WEIGHTED_WITHIN_TOLERANCE')
      .withExecutionMode('propose')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    const cycleResult = await context.orchestrator.executeCycle(event);

    // Assert: No routes proposed when within tolerance
    expect(cycleResult.proposedRoutes.length).to.equal(0);
  });

  it('should execute full rebalance cycle with actual transfers', async function () {
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(WEIGHTED_STRATEGY_CONFIG)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Assert: Rebalance intent was created with correct fields
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.base);
    expect(activeIntents[0].amount).to.equal(1000000000n);
    expect(activeIntents[0].status).to.equal('in_progress');

    // Assert: Rebalance action was created
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    expect(inProgressActions[0].intentId).to.equal(activeIntents[0].id);

    // Assert: Ethereum balance decreased by 1000 USDC (rebalance amount)
    const balancesAfterRebalance = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    // Initial: 7000 USDC - Rebalance: 1000 USDC = 6000 USDC
    expect(
      balancesAfterRebalance.ethereum.toString(),
      'INCENTIV ethereum collateral should be 6000 USDC after rebalance',
    ).to.equal('6000000000');

    // Capture action details for relay
    const actionToBase = inProgressActions[0];
    const ethProvider = forkedProviders.get('ethereum')!;

    // Relay the rebalance message to destination
    expect(actionToBase.txHash, 'Action should have txHash').to.exist;
    const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
      actionToBase.txHash!,
    );
    const rebalanceRelayResult = await tryRelayMessage(
      multiProvider,
      hyperlaneCore,
      {
        dispatchTx: rebalanceTxReceipt,
        messageId: actionToBase.messageId,
        origin: 'ethereum',
        destination: 'base',
      },
    );
    expect(rebalanceRelayResult.success, 'Rebalance relay should succeed').to.be
      .true;

    // Sync actions to detect delivery and mark complete
    const blockTags = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags);
    await context.tracker.syncRebalanceActions(blockTags);

    // Assert: Action is now complete
    const completedAction = await context.tracker.getRebalanceAction(
      actionToBase.id,
    );
    expect(completedAction!.status).to.equal('complete');

    // Assert: Intent is now complete
    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');
    expect(completedIntent!.fulfilledAmount).to.equal(1000000000n);

    // Assert: No more in-progress actions
    const remainingActions = await context.tracker.getInProgressActions();
    expect(remainingActions.length).to.equal(0);
  });

  it('should handle stuck transfer and propose routes to destination', async function () {
    // Build context with Weighted strategy
    // Initial: eth=7000, arb=2000, base=1000 (total=10000)
    // Target: eth=60% (6000), arb=20% (2000), base=20% (2000)
    // Cycle 1 will create inflight eth→base for ~1000 USDC
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy(WEIGHTED_STRATEGY_CONFIG)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute rebalance to create inflight eth→base =====
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags1 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags1);
    await context.tracker.syncRebalanceActions(blockTags1);

    const inflightAfterCycle1 = await context.tracker.getInProgressActions();
    expect(
      inflightAfterCycle1.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToBase = inflightAfterCycle1.find(
      (a) =>
        a.destination === DOMAIN_IDS.base && a.origin === DOMAIN_IDS.ethereum,
    );
    expect(inflightToBase, 'Should have inflight action eth→base').to.exist;

    const inflightAmount = BigNumber.from(inflightToBase!.amount);
    expect(inflightAmount.gt(0), 'Inflight amount should be positive').to.be
      .true;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Weighted now sees: base effective = current + inflight ≈ 2000 (target)
    // Should propose reduced amount or nothing to base
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    const cycleResult2 = await context.orchestrator.executeCycle(event2);

    const blockTags2 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags2);
    await context.tracker.syncRebalanceActions(blockTags2);

    // Check if new routes to base were proposed
    const routesToBase = cycleResult2.proposedRoutes.filter(
      (r) => r.destination === 'base',
    );
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToBase = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.base &&
        a.id !== inflightToBase!.id &&
        a.status === 'in_progress',
    );

    if (routesToBase.length > 0 || newActionsToBase.length > 0) {
      // If route was proposed, should be much smaller than original 1000 USDC
      const proposedAmount =
        routesToBase.length > 0
          ? routesToBase[0].amount
          : BigNumber.from(newActionsToBase[0].amount).toBigInt();
      expect(
        proposedAmount < 500000000n,
        `Amount to base (${proposedAmount}) should be reduced accounting for inflight`,
      ).to.be.true;
    }
    // If no new route to base, that's valid (within tolerance after inflight)

    // Verify inflight still exists and action tracking is working
    const finalInProgress = await context.tracker.getInProgressActions();
    const inflightStillActive = finalInProgress.find(
      (a) => a.id === inflightToBase!.id,
    );
    expect(inflightStillActive, 'Inflight action should still be tracked').to
      .exist;
    expect(inflightStillActive!.status).to.equal('in_progress');
  });
});
