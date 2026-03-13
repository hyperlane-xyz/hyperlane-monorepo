import { expect } from 'chai';
import { Connection } from '@solana/web3.js';
import { providers } from 'ethers';

import { HyperlaneCore, MultiProvider, snapshot } from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  DOMAIN_IDS,
  type NativeDeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import {
  MAILBOX_PROGRAM_ID,
  MIXED_MIN_AMOUNT_TARGET_WEI,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
  type SvmDeployedAddresses,
} from './fixtures/svm-routes.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { MixedTestRebalancerBuilder } from './harness/MixedTestRebalancerBuilder.js';
import { resetSnapshotsAndRefreshProviders } from './harness/SnapshotHelper.js';
import {
  classifyMixedChains,
  drainSvmWarpRoute,
  getMixedRouterBalances,
  relayMixedInventoryDeposits,
} from './harness/SvmTestHelpers.js';
import { SvmEvmLocalDeploymentManager } from './harness/SvmEvmLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import type { TestRebalancerContext } from './harness/TestRebalancer.js';
// ── All chains: 3 EVM + 1 SVM ──
const ALL_MIXED_CHAINS = [...TEST_CHAINS, SVM_CHAIN_NAME] as const;

// ── Strategy config covering 3 EVM chains + 1 SVM chain ──

function buildMixedStrategyConfig(): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        [SVM_CHAIN_NAME]: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

// ── Test suite ──

describe('Mixed EVM+SVM Inventory Rebalancer E2E', function () {
  this.timeout(600_000);

  let manager: SvmEvmLocalDeploymentManager;
  let evmAddresses: NativeDeployedAddresses;
  let svmAddresses: SvmDeployedAddresses;
  let svmPrivateKey: string;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let multiProvider: MultiProvider;
  let hyperlaneCore: HyperlaneCore;
  let svmConnection: Connection;
  let snapshotIds: Map<string, string>;
  let mockBridge: MockExternalBridge;

  const expectedDeficit = MIXED_MIN_AMOUNT_TARGET_WEI.toBigInt();

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

  before(async function () {
    manager = new SvmEvmLocalDeploymentManager();
    await manager.setup();

    const evmManager = manager.getEvmDeploymentManager();
    evmAddresses = evmManager.getContext().deployedAddresses;
    svmAddresses = manager.getSvmDeployedAddresses();
    svmPrivateKey = JSON.stringify(
      Array.from(manager.getSvmChainManager().getDeployerKeypair().secretKey),
    );

    localProviders = evmManager.getContext().providers;
    multiProvider = evmManager.getContext().multiProvider;
    svmConnection = manager.getSvmChainManager().getConnection();

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: evmAddresses.chains[chain].mailbox,
        interchainSecurityModule: evmAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    mockBridge = new MockExternalBridge(
      evmAddresses,
      multiProvider,
      hyperlaneCore,
    );

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    mockBridge.reset();
    await resetSnapshotsAndRefreshProviders({
      localProviders,
      multiProvider,
      snapshotIds,
    });
    await drainSvmWarpRoute(manager, svmAddresses.warpTokenAta);
  });

  after(async function () {
    if (manager) await manager.teardown();
  });

  // ── Scenario 1 ──

  it('executes transferRemote when destination collateral is below minimum and inventory exists locally', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EMPTY_DEST')
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    const depositAction = inProgressActions.find(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositAction).to.exist;

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedAction = await context.tracker.getRebalanceAction(
      depositAction!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const finalBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    const { surplusChain, neutralChains } = classifyMixedChains(
      'anvil2',
      depositAction!,
      ALL_MIXED_CHAINS,
    );

    expect(
      finalBalances.anvil2.gt(initialBalances.anvil2),
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    for (const chain of neutralChains) {
      expect(
        finalBalances[chain].eq(initialBalances[chain]),
        `Uninvolved router (${chain}) balance should remain unchanged`,
      ).to.be.true;
    }
  });

  // ── Scenario 2 ──

  it('handles partial deposit, bridges inventory, then completes final deposit', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('SIGNER_PARTIAL_ANVIL2')
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    // Cycle 1: partial deposit from limited signer balance on anvil2
    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(expectedDeficit);
    expect(partialIntents[0].intent.amount).to.equal(expectedDeficit);
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil2);

    const deposits = await context.tracker.getActionsForIntent(
      partialIntents[0].intent.id,
    );
    expect(deposits.length).to.equal(1);
    expect(deposits[0].type).to.equal('inventory_deposit');
    expect(deposits[0].origin).to.equal(DOMAIN_IDS.anvil2);
    expect(deposits[0].amount).to.equal(partialIntents[0].completedAmount);

    // Cycle 2: bridge movement from another chain
    await executeCycle(context);

    const preSync = await context.tracker.getInProgressActions();
    expect(preSync.length).to.equal(1);
    const preSyncMovement = preSync.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(preSyncMovement).to.exist;
    expect(preSyncMovement!.status).to.equal('in_progress');

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const movementState = await context.tracker.getRebalanceAction(
      preSyncMovement!.id,
    );
    expect(movementState?.status).to.equal('complete');

    const activeIntent = partialIntents[0].intent;
    const actionsAfterBridge = await context.tracker.getActionsForIntent(
      activeIntent.id,
    );
    expect(actionsAfterBridge.length).to.equal(2);
    const movementAction = actionsAfterBridge.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementAction!.destination).to.equal(DOMAIN_IDS.anvil2);
    expect(movementAction!.status).to.equal('complete');
    expect(movementAction!.amount >= partialIntents[0].remaining).to.be.true;

    // Cycle 3: final deposit completes the intent
    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntent.id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const partialAfterFinalCycle =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterFinalCycle.length).to.equal(0);
    const finalActions = await context.tracker.getActionsForIntent(
      activeIntent.id,
    );
    expect(finalActions.length).to.equal(3);
    const allDeposits = finalActions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(allDeposits.length).to.equal(2);
    const totalDeposited = allDeposits.reduce((sum, a) => sum + a.amount, 0n);
    expect(totalDeposited).to.equal(activeIntent.amount);

    const finalBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    const { surplusChain, neutralChains } = classifyMixedChains(
      'anvil2',
      allDeposits[0],
      ALL_MIXED_CHAINS,
    );

    expect(
      finalBalances.anvil2.gt(initialBalances.anvil2),
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    for (const chain of neutralChains) {
      expect(
        finalBalances[chain].eq(initialBalances[chain]),
        `Uninvolved router (${chain}) balance should remain unchanged`,
      ).to.be.true;
    }
  });

  // ── Scenario 3 ──

  it('loops across multiple cycles with partial fills before final completion', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('SIGNER_LOW_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    // Cycle 1: partial deposit from local signer inventory on anvil2
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);
    const targetIntentId = activeIntents[0].id;

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(expectedDeficit);
    const c1Amount = partialIntents[0].completedAmount;

    let actions = await context.tracker.getActionsForIntent(targetIntentId);
    let movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    let depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(1);
    expect(movementActions.length).to.equal(0);
    expect(depositActions.length).to.equal(1);

    // Cycle 2: bridge movements from other chains
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(expectedDeficit);
    expect(partialIntents[0].completedAmount).to.equal(c1Amount);

    actions = await context.tracker.getActionsForIntent(targetIntentId);
    movementActions = actions.filter((a) => a.type === 'inventory_movement');
    depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(3);
    expect(movementActions.length).to.equal(2);
    expect(depositActions.length).to.equal(1);
    const origins = new Set(movementActions.map((a) => a.origin));
    expect(origins.has(DOMAIN_IDS.anvil1)).to.be.true;
    expect(origins.has(DOMAIN_IDS.anvil3)).to.be.true;
    movementActions.forEach((a) => {
      expect(a.destination).to.equal(DOMAIN_IDS.anvil2);
      expect(a.status).to.equal('complete');
    });

    // Cycle 3: final deposit covers remaining amount — intent completes
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(0);
    partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

    actions = await context.tracker.getActionsForIntent(targetIntentId);
    movementActions = actions.filter((a) => a.type === 'inventory_movement');
    depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(4);
    expect(movementActions.length).to.equal(2);
    expect(depositActions.length).to.equal(2);

    const finalIntent =
      await context.tracker.getRebalanceIntent(targetIntentId);
    expect(finalIntent!.status).to.equal('complete');
  });

  // ── Scenario 4 ──

  it('retries after bridge execution failure', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('SIGNER_FUNDED_ANVIL1')
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    // Cycle 1: Bridge fails — intent created but stays not_started, no actions
    mockBridge.failNextExecute();
    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(0);

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].intent.status).to.equal('not_started');
    expect(partialIntents[0].completedAmount).to.equal(0n);
    expect(partialIntents[0].remaining).to.equal(expectedDeficit);

    const intentId = partialIntents[0].intent.id;
    const actionsAfterFailure =
      await context.tracker.getActionsForIntent(intentId);
    expect(actionsAfterFailure.length).to.equal(0);

    // Cycle 2: Bridge succeeds — creates movement, intent becomes in_progress
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const cycle2Active = await context.tracker.getActiveRebalanceIntents();
    expect(cycle2Active.length).to.equal(1);
    const cycle2Partial =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(cycle2Partial.length).to.equal(1);

    const cycle2Actions = await context.tracker.getActionsForIntent(intentId);
    expect(cycle2Actions.length).to.equal(1);
    const movementAction = cycle2Actions.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.status).to.equal('complete');

    const cycle2Intent = await context.tracker.getRebalanceIntent(intentId);
    expect(cycle2Intent!.status).to.equal('in_progress');

    // Cycle 3: Deposit completes the intent
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent!.status).to.equal('complete');

    const finalActions = await context.tracker.getActionsForIntent(intentId);
    expect(finalActions.length).to.equal(2);
    const finalMovement = finalActions.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(finalMovement).to.exist;
    const depositAction = finalActions.find(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositAction).to.exist;

    const finalBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    const { surplusChain, neutralChains } = classifyMixedChains(
      'anvil2',
      depositAction!,
      ALL_MIXED_CHAINS,
    );

    expect(
      finalBalances.anvil2.gt(initialBalances.anvil2),
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    for (const chain of neutralChains) {
      expect(
        finalBalances[chain].eq(initialBalances[chain]),
        `Uninvolved router (${chain}) balance should remain unchanged`,
      ).to.be.true;
    }
  });

  // ── Scenario 5 ──

  it('enforces single active inventory intent when multiple deficit chains exist', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_MULTI_DEFICIT')
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    // Cycle 1: first intent for anvil2
    await executeCycle(context);

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);
    const firstIntentId = activeIntents[0].id;

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].hasInflightDeposit).to.equal(true);

    const actions = await context.tracker.getActionsForIntent(firstIntentId);
    expect(actions.length).to.equal(1);
    expect(
      actions.filter((a) => a.type === 'inventory_movement').length,
    ).to.equal(0);
    expect(
      actions.filter((a) => a.type === 'inventory_deposit').length,
    ).to.equal(1);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(completedFirstIntent!.status).to.equal('complete');

    const depositAction = actions.find((a) => a.type === 'inventory_deposit');
    const midBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    const { surplusChain, neutralChains } = classifyMixedChains(
      'anvil2',
      depositAction!,
      ALL_MIXED_CHAINS,
    );

    expect(
      midBalances.anvil2.gt(initialBalances.anvil2),
      'Deficit router (anvil2) balance should increase',
    ).to.be.true;
    expect(
      midBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    for (const chain of neutralChains) {
      expect(
        midBalances[chain].eq(initialBalances[chain]),
        `Uninvolved router (${chain}) balance should remain unchanged`,
      ).to.be.true;
    }

    // Cycle 2: second intent for anvil3
    await executeCycle(context);
    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);
  });

  // ── Scenario 6 ──

  it('uses multiple bridge movements from different sources before completing deposit', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('SIGNER_SPLIT_SOURCES')
      .withMockExternalBridge(mockBridge)
      .build();

    // Cycle 1: creates intent + both bridge movements from anvil1 and anvil3
    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);
    const intentId = activeIntents[0].id;

    // Sync: both movements should be complete after a single cycle
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    let actions = await context.tracker.getActionsForIntent(intentId);
    expect(actions.length).to.equal(2);
    const movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementActions.length).to.equal(2);

    // Verify movements from different sources, both targeting anvil2
    const origins = new Set(movementActions.map((a) => a.origin));
    expect(origins.has(DOMAIN_IDS.anvil1)).to.be.true;
    expect(origins.has(DOMAIN_IDS.anvil3)).to.be.true;
    movementActions.forEach((a) => {
      expect(a.destination).to.equal(DOMAIN_IDS.anvil2);
      expect(a.status).to.equal('complete');
    });

    // Cycle 2: deposit from bridged funds completes the intent
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const finalActiveIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(finalActiveIntents.length).to.equal(0);
    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

    actions = await context.tracker.getActionsForIntent(intentId);
    expect(actions.length).to.equal(3);
    expect(
      actions.filter((a) => a.type === 'inventory_movement').length,
    ).to.equal(2);
    expect(
      actions.filter((a) => a.type === 'inventory_deposit').length,
    ).to.equal(1);

    const finalIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(finalIntent!.status).to.equal('complete');
  });

  // ── Scenario 7 ──

  it('bridges inventory from SVM when all EVM chains are in deficit', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildMixedStrategyConfig())
      .withBalances('INVENTORY_EVM_ALL_DEFICIT')
      .withInventorySignerBalances('SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    const movementAction = inProgressActions.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.origin).to.equal(SVM_DOMAIN_ID);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(completedMovement!.status).to.equal('complete');
  });
});
