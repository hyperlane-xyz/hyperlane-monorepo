import { expect } from 'chai';
import { JsonRpcProvider, Wallet } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../config/types.js';

import {
  ANVIL_USER_PRIVATE_KEY,
  DOMAIN_IDS,
  ERC20_INVENTORY_MIN_AMOUNT_TARGET_RAW,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAINS,
  buildErc20InventoryMinAmountStrategyConfig,
} from './fixtures/routes.js';
import { Erc20InventoryLocalDeploymentManager } from './harness/Erc20InventoryLocalDeploymentManager.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import {
  classifyChains,
  getErc20RouterBalances,
  getFirstMonitorEvent,
  relayInProgressInventoryDeposits,
} from './harness/TestHelpers.js';
import {
  TestRebalancerBuilder,
  type TestRebalancerContext,
} from './harness/TestRebalancer.js';

describe('Erc20 InventoryMinAmountStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20InventoryLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let erc20DeployedAddresses: Erc20InventoryDeployedAddresses;
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new Wallet(ANVIL_USER_PRIVATE_KEY).address;
  // Expected deficit when a chain's router balance is 0:
  // target (from strategy config) - 0 = target.
  const expectedDeficit = ERC20_INVENTORY_MIN_AMOUNT_TARGET_RAW;

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

  before(async function () {
    deploymentManager = new Erc20InventoryLocalDeploymentManager(
      inventorySignerAddress,
    );
    const ctx = await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    erc20DeployedAddresses = ctx.deployedAddresses;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: erc20DeployedAddresses.chains[chain].mailbox,
        interchainSecurityModule: erc20DeployedAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    mockBridge = new MockExternalBridge(
      erc20DeployedAddresses,
      multiProvider,
      hyperlaneCore,
      'erc20',
    );

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    mockBridge.reset();
    for (const [chain, provider] of localProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      snapshotIds.set(chain, await snapshot(provider));
      // Provider cache may return stale block numbers after evm_revert.
      // high-water mark (_maxInternalBlockNumber). After evm_revert the
      // actual chain block number decreases, so reset the cache.
      Reflect.set(provider, '_maxInternalBlockNumber', -1);
      Reflect.set(provider, '_internalBlockNumber', null);
    }
  });

  after(async function () {
    if (deploymentManager) await deploymentManager.stop();
  });

  it('executes transferRemote when destination collateral is below minimum and inventory exists locally', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
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

    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
    );

    const completedAction = await context.tracker.getRebalanceAction(
      depositAction!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const finalBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

    const { surplusChain, neutralChain } = classifyChains(
      'anvil2',
      depositAction!,
    );

    expect(
      finalBalances.anvil2 > initialBalances.anvil2,
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain] < initialBalances[surplusChain],
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain] === initialBalances[neutralChain],
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }
  });

  it('handles partial deposit, bridges inventory, then completes final deposit', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('ERC20_SIGNER_PARTIAL_ANVIL2')
      .withExecutionMode('execute')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

    await executeCycle(context);
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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

    await executeCycle(context);

    const preSync = await context.tracker.getInProgressActions();
    expect(preSync.length).to.equal(1);
    const preSyncMovement = preSync.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(preSyncMovement).to.exist;
    expect(preSyncMovement!.status).to.equal('in_progress');

    // executeCycle calls syncActionTracker at the START of each cycle, so
    // bridge actions created DURING the cycle above aren't synced yet.
    // In production the next cycle's sync picks them up; in tests we
    // sync manually to assert against the results between cycles.
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

    await executeCycle(context);
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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

    const finalBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

    const { surplusChain, neutralChain } = classifyChains(
      'anvil2',
      allDeposits[0],
    );

    expect(
      finalBalances.anvil2 > initialBalances.anvil2,
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain] < initialBalances[surplusChain],
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain] === initialBalances[neutralChain],
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }
  });

  it('loops across multiple cycles with partial fills before final completion', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('ERC20_SIGNER_LOW_ALL')
      .withExecutionMode('execute')
      .build();

    // Cycle 1: partial deposit from local signer inventory on anvil2
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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

    // Cycle 2: bridge movements from anvil1 + anvil3 — completedAmount unchanged (movements pending relay)
    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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

  it('retries after bridge execution failure', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('ERC20_SIGNER_FUNDED_ANVIL1')
      .withExecutionMode('execute')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
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
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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

    const finalBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );
    const { surplusChain, neutralChain } = classifyChains(
      'anvil2',
      depositAction!,
    );

    expect(
      finalBalances.anvil2 > initialBalances.anvil2,
      'Destination router balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain] < initialBalances[surplusChain],
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain] === initialBalances[neutralChain],
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }
  });

  it('enforces single active inventory intent when multiple deficit chains exist', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_MULTI_DEFICIT')
      .withExecutionMode('execute')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

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
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
    );

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(completedFirstIntent!.status).to.equal('complete');

    const depositAction = actions.find((a) => a.type === 'inventory_deposit');
    const midBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );
    const { surplusChain, neutralChain } = classifyChains(
      'anvil2',
      depositAction!,
    );

    expect(
      midBalances.anvil2 > initialBalances.anvil2,
      'Deficit router (anvil2) balance should increase',
    ).to.be.true;
    expect(
      midBalances[surplusChain] < initialBalances[surplusChain],
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        midBalances[neutralChain] === initialBalances[neutralChain],
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }

    await executeCycle(context);
    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(expectedDeficit);
  });

  it('uses multiple bridge movements from different sources before completing deposit', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withInventorySignerBalances('ERC20_SIGNER_SPLIT_SOURCES')
      .withExecutionMode('execute')
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
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
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
});
