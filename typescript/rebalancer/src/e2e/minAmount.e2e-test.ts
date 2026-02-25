import { expect } from 'chai';

import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import { getAllCollateralBalances } from './harness/BridgeSetup.js';
import {
  type LocalDeploymentContext,
  LocalDeploymentManager,
} from './harness/LocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

describe('MinAmountStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, ReturnType<MultiProvider['getProvider']>>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;
  let minAmountStrategyConfig: StrategyConfig[];

  before(async function () {
    deploymentManager = new LocalDeploymentManager();
    const ctx: LocalDeploymentContext = await deploymentManager.start();
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

    minAmountStrategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: {
          anvil1: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
            bridge: deployedAddresses.bridgeRoute1.anvil1,
          },
          anvil2: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
            bridge: deployedAddresses.bridgeRoute1.anvil2,
          },
          anvil3: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
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
    for (const [chain, provider] of localProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('should propose rebalance routes when chain is below minimum', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountStrategyConfig)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: ethereum→arbitrum, amount=70 USDC to reach 120 target from 50
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(70000000n);
  });

  it('should not propose routes when all chains at or above minimum', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountStrategyConfig)
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
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountStrategyConfig)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const initialCollateralBalances = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Assert: Rebalance intent was created with correct fields
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(70000000n);

    // Assert: Rebalance action was created
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);

    const actionToArbitrum = inProgressActions[0];
    expect(actionToArbitrum.destination).to.equal(DOMAIN_IDS.anvil2);
    expect(actionToArbitrum.amount).to.equal(70000000n);

    // Assert: Monitored route collateral on origin DECREASED (sent to bridge)
    const balancesAfterRebalance = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    // Assert: ethereum balance decreased by 70 USDC
    const expectedDecrease = 70000000n;
    expect(initialCollateralBalances.anvil1 - expectedDecrease).to.equal(
      balancesAfterRebalance.anvil1,
    );

    // Relay the rebalance message to destination
    const ethProvider = localProviders.get('anvil1')!;
    const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
      actionToArbitrum.txHash!,
    );
    const rebalanceRelayResult = await tryRelayMessage(
      multiProvider,
      hyperlaneCore,
      {
        dispatchTx: rebalanceTxReceipt,
        messageId: actionToArbitrum.messageId!,
        origin: 'anvil1',
        destination: 'anvil2',
      },
    );
    expect(
      rebalanceRelayResult.success,
      `Rebalance relay should succeed: ${rebalanceRelayResult.error}`,
    ).to.be.true;

    // Sync actions to detect delivery and mark complete
    const blockTags = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags);

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
  });

  it('should handle stuck transfer and propose routes to destination', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountStrategyConfig)
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
    await context.tracker.syncRebalanceActions(blockTags1);

    const inProgress = await context.tracker.getInProgressActions();
    expect(
      inProgress.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToArb = inProgress.find(
      (a) =>
        a.destination === DOMAIN_IDS.anvil2 && a.origin === DOMAIN_IDS.anvil1,
    );
    expect(inflightToArb, 'Should have inflight action eth→arb').to.exist;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Strategy sees: arb effective = 50 + inflight ≈ 120 (target)
    // Should propose reduced amount or nothing to arb (within tolerance)
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const blockTags = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags);

    // Check if new routes to arb were proposed
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToArb = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.anvil2 &&
        a.id !== inflightToArb!.id &&
        a.status === 'in_progress',
    );

    if (newActionsToArb.length > 0) {
      // If route was proposed, should be much smaller than original ~70 USDC
      const proposedAmount = BigInt(newActionsToArb[0].amount);
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
