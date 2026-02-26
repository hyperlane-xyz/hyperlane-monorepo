import { expect } from 'chai';
import { JsonRpcProvider } from 'ethers';

import { HyperlaneCore, MultiProvider, snapshot } from '@hyperlane-xyz/sdk';

import {
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import { getAllCollateralBalances } from './harness/BridgeSetup.js';
import { type LocalDeploymentContext } from './harness/BaseLocalDeploymentManager.js';
import { Erc20LocalDeploymentManager } from './harness/Erc20LocalDeploymentManager.js';
import { resetSnapshotsAndRefreshProviders } from './harness/SnapshotHelper.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

describe('WeightedStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;
  let weightedStrategyConfig: StrategyConfig[];

  before(async function () {
    deploymentManager = new Erc20LocalDeploymentManager();
    const ctx: LocalDeploymentContext<DeployedAddresses> =
      await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    deployedAddresses = ctx.deployedAddresses;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: deployedAddresses.chains[chain].mailbox,
        interchainSecurityModule: deployedAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    weightedStrategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          anvil1: {
            weighted: { weight: 60n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil1,
          },
          anvil2: {
            weighted: { weight: 20n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil2,
          },
          anvil3: {
            weighted: { weight: 20n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil3,
          },
        },
      },
    ];

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    await resetSnapshotsAndRefreshProviders({
      localProviders,
      multiProvider,
      snapshotIds,
    });
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('should propose rebalance routes when weights are unbalanced', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: Strategy created rebalance intent for the imbalanced chain
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(1000000000n);
  });

  it('should not propose routes when within tolerance', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withBalances('WEIGHTED_WITHIN_TOLERANCE')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: No intents created when within tolerance
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(0);
  });

  it('should execute full rebalance cycle with actual transfers', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Assert: Rebalance intent was created with correct fields
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(1000000000n);
    expect(activeIntents[0].status).to.equal('in_progress');

    // Assert: Rebalance action was created
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    expect(inProgressActions[0].intentId).to.equal(activeIntents[0].id);

    // Assert: Ethereum balance decreased by 1000 USDC (rebalance amount)
    const balancesAfterRebalance = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    // Initial: 7000 USDC - Rebalance: 1000 USDC = 6000 USDC
    expect(
      balancesAfterRebalance.anvil1.toString(),
      'anvil1 collateral should be 6000 USDC after rebalance',
    ).to.equal('6000000000');

    // Capture action details for relay
    const actionToBase = inProgressActions[0];
    const ethProvider = localProviders.get('anvil1')!;

    // Relay the rebalance message to destination
    expect(actionToBase.txHash, 'Action should have txHash').to.exist;
    const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
      actionToBase.txHash!,
    );
    const rebalanceRelayResult = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      {
        dispatchTx: rebalanceTxReceipt,
        messageId: actionToBase.messageId!,
        origin: 'anvil1',
        destination: 'anvil3',
      },
    );
    expect(
      rebalanceRelayResult.success,
      `Rebalance relay should succeed: ${rebalanceRelayResult.error}`,
    ).to.be.true;

    const blockTags = await context.getConfirmedBlockTags();
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

    // Assert: No more in-progress actions
    const remainingActions = await context.tracker.getInProgressActions();
    expect(remainingActions.length).to.equal(0);
  });

  it('should handle stuck transfer and propose routes to destination', async function () {
    // Build context with Weighted strategy
    // Initial: eth=7000, arb=2000, base=1000 (total=10000)
    // Target: eth=60% (6000), arb=20% (2000), base=20% (2000)
    // Cycle 1 will create inflight eth→base for ~1000 USDC
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withBalances('WEIGHTED_IMBALANCED')
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute rebalance to create inflight eth→base =====
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags1 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags1);

    const inflightAfterCycle1 = await context.tracker.getInProgressActions();
    expect(
      inflightAfterCycle1.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToBase = inflightAfterCycle1.find(
      (a) =>
        a.destination === DOMAIN_IDS.anvil3 && a.origin === DOMAIN_IDS.anvil1,
    );
    expect(inflightToBase, 'Should have inflight action eth→base').to.exist;

    const inflightAmount = BigInt(inflightToBase!.amount);
    expect(inflightAmount > 0n, 'Inflight amount should be positive').to.be
      .true;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Weighted now sees: base effective = current + inflight ≈ 2000 (target)
    // Should create reduced amount or nothing to base
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const blockTags2 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags2);

    // Check if new actions to base were created
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToBase = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.anvil3 &&
        a.id !== inflightToBase!.id &&
        a.status === 'in_progress',
    );

    if (newActionsToBase.length > 0) {
      // If action was created, should be much smaller than original 1000 USDC
      const proposedAmount = BigInt(newActionsToBase[0].amount);
      expect(
        proposedAmount < 500000000n,
        `Amount to base (${proposedAmount}) should be reduced accounting for inflight`,
      ).to.be.true;
    }
    // If no new action to base, that's valid (within tolerance after inflight)

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
