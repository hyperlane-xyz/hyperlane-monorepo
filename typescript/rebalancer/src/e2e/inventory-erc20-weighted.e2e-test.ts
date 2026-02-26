import { expect } from 'chai';
import { ethers, providers } from 'ethers';

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
  ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC,
  ERC20_WEIGHTED_EXPECTED_DEFICIT_1200USDC,
  ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAINS,
  buildErc20InventoryWeightedStrategyConfig,
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

describe('Erc20 Inventory WeightedStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20InventoryLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let erc20DeployedAddresses: Erc20InventoryDeployedAddresses;
  let weightedStrategyConfig: ReturnType<
    typeof buildErc20InventoryWeightedStrategyConfig
  >;
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY)
    .address;

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

    weightedStrategyConfig = buildErc20InventoryWeightedStrategyConfig(
      erc20DeployedAddresses,
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
      // ethers v5 refuses to return block numbers lower than a previous
      // high-water mark (_maxInternalBlockNumber). After evm_revert the
      // actual chain block number decreases, so reset the cache.
      Reflect.set(provider, '_maxInternalBlockNumber', -1);
      Reflect.set(provider, '_internalBlockNumber', null);
    }
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('creates direct inventory_deposit when destination has enough inventory', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_IMBALANCED')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC.toBigInt(),
    );
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
    expect(completedIntent?.status).to.equal('complete');

    const finalBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );
    const { surplusChain, neutralChain } = classifyChains(
      'anvil3',
      depositAction!,
    );

    expect(
      finalBalances.anvil3.gt(initialBalances.anvil3),
      'Deficit router (anvil3) balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain].eq(initialBalances[neutralChain]),
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }
  });

  it('handles partial deposit, then bridge, then final deposit', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventorySignerBalances('ERC20_SIGNER_PARTIAL_ANVIL3')
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_IMBALANCED')
      .build();

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
    expect(partialIntents[0].intent.amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC.toBigInt(),
    );
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC.toBigInt());

    const firstCycleActions = await context.tracker.getActionsForIntent(
      partialIntents[0].intent.id,
    );
    expect(firstCycleActions.length).to.equal(1);
    expect(firstCycleActions[0].type).to.equal('inventory_deposit');
    expect(firstCycleActions[0].origin).to.equal(DOMAIN_IDS.anvil3);
    expect(firstCycleActions[0].amount).to.equal(
      partialIntents[0].completedAmount,
    );

    const intentId = partialIntents[0].intent.id;

    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    const movementAction = inProgressActions.find(
      (action) => action.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementAction!.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(movementAction!.status).to.equal('in_progress');

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const movementState = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(movementState?.status).to.equal('complete');

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

    const partialAfterFinalCycle =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterFinalCycle.length).to.equal(0);

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(intentId);
    const allDeposits = actions.filter((a) => a.type === 'inventory_deposit');
    const movements = actions.filter((a) => a.type === 'inventory_movement');
    expect(actions.length).to.equal(3);
    expect(movements.length).to.equal(1);
    expect(allDeposits.length).to.equal(2);
    const totalDeposited = allDeposits.reduce((sum, a) => sum + a.amount, 0n);
    expect(totalDeposited).to.equal(completedIntent!.amount);
  });

  it('completes intent after multiple partial inventory fill cycles', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventorySignerBalances('ERC20_SIGNER_WEIGHTED_LOW_ALL')
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_ALL_ANVIL1')
      .build();

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
    expect(activeIntents[0].amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC.toBigInt(),
    );
    const trackedIntentId = activeIntents[0].id;

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC.toBigInt());

    let actions = await context.tracker.getActionsForIntent(trackedIntentId);
    let movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    let depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(1);
    expect(movementActions.length).to.equal(0);
    expect(depositActions.length).to.equal(1);
    const c0Amount = partialIntents[0].completedAmount;

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
    ).to.equal(ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC.toBigInt());

    actions = await context.tracker.getActionsForIntent(trackedIntentId);
    movementActions = actions.filter((a) => a.type === 'inventory_movement');
    depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(2);
    expect(movementActions.length).to.equal(1);
    expect(depositActions.length).to.equal(1);
    expect(movementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementActions[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(movementActions[0].status).to.equal('complete');
    expect(partialIntents[0].completedAmount).to.equal(c0Amount);

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

    actions = await context.tracker.getActionsForIntent(trackedIntentId);
    movementActions = actions.filter((a) => a.type === 'inventory_movement');
    depositActions = actions.filter((a) => a.type === 'inventory_deposit');
    expect(actions.length).to.equal(3);
    expect(movementActions.length).to.equal(1);
    expect(depositActions.length).to.equal(2);

    const completedIntent =
      await context.tracker.getRebalanceIntent(trackedIntentId);
    expect(completedIntent?.status).to.equal('complete');
  });

  it('retries after bridge execution failure', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventorySignerBalances('ERC20_SIGNER_ZERO_ANVIL3')
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_IMBALANCED')
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
    expect(partialIntents[0].remaining).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC.toBigInt(),
    );

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
      'anvil3',
      depositAction!,
    );

    expect(
      finalBalances.anvil3.gt(initialBalances.anvil3),
      'Deficit router (anvil3) balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain].eq(initialBalances[neutralChain]),
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }
  });

  it('enforces single active inventory intent when multiple routes are proposed', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_ALL_ANVIL1')
      .build();

    const initialBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );

    await executeCycle(context);

    const firstCycleIntents = await context.tracker.getActiveRebalanceIntents();
    expect(firstCycleIntents.length).to.equal(1);
    expect(firstCycleIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(firstCycleIntents[0].amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC.toBigInt(),
    );

    const firstIntentId = firstCycleIntents[0].id;
    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].hasInflightDeposit).to.equal(true);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
    );

    partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);
    const actions = await context.tracker.getActionsForIntent(firstIntentId);
    expect(actions.length).to.equal(1);
    const movementCount = actions.filter(
      (a) => a.type === 'inventory_movement',
    ).length;
    const depositCount = actions.filter(
      (a) => a.type === 'inventory_deposit',
    ).length;
    expect(movementCount).to.equal(0);
    expect(depositCount).to.equal(1);

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(completedFirstIntent?.status).to.equal('complete');

    const finalBalances = await getErc20RouterBalances(
      localProviders,
      erc20DeployedAddresses,
    );
    const depositAction = await context.tracker.getRebalanceAction(
      actions.find((a) => a.type === 'inventory_deposit')!.id,
    );
    const { surplusChain, neutralChain } = classifyChains(
      'anvil2',
      depositAction!,
    );

    expect(
      finalBalances.anvil2.gt(initialBalances.anvil2),
      'Deficit router (anvil2) balance should increase',
    ).to.be.true;
    expect(
      finalBalances[surplusChain].lt(initialBalances[surplusChain]),
      `Surplus router (${surplusChain}) balance should decrease`,
    ).to.be.true;
    if (neutralChain) {
      expect(
        finalBalances[neutralChain].eq(initialBalances[neutralChain]),
        'Uninvolved router balance should remain unchanged',
      ).to.be.true;
    }

    await executeCycle(context);
    const secondCycleIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(secondCycleIntents.length).to.equal(1);
    expect(secondCycleIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(secondCycleIntents[0].amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC.toBigInt(),
    );
  });

  it('uses bridge movements from different source chains before completion', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventorySignerBalances('ERC20_SIGNER_WEIGHTED_BRIDGE_SOURCES')
      .withInventoryBalances('ERC20_INVENTORY_WEIGHTED_PARTIAL_SUPPLY')
      .build();

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

    const cycle1ActiveIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(cycle1ActiveIntents.length).to.equal(1);
    expect(cycle1ActiveIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(cycle1ActiveIntents[0].amount).to.equal(
      ERC20_WEIGHTED_EXPECTED_DEFICIT_1200USDC.toBigInt(),
    );
    const intentId = cycle1ActiveIntents[0].id;

    const cycle1PartialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(cycle1PartialIntents.length).to.equal(1);
    expect(cycle1PartialIntents[0].intent.id).to.equal(intentId);
    expect(cycle1PartialIntents[0].remaining > 0n).to.be.true;
    expect(
      cycle1PartialIntents[0].completedAmount +
        cycle1PartialIntents[0].remaining,
    ).to.equal(ERC20_WEIGHTED_EXPECTED_DEFICIT_1200USDC.toBigInt());

    let actions = await context.tracker.getActionsForIntent(intentId);
    expect(actions.length).to.equal(1);
    expect(
      actions.filter((a) => a.type === 'inventory_deposit').length,
    ).to.equal(1);
    expect(
      actions.filter((a) => a.type === 'inventory_movement').length,
    ).to.equal(0);

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

    actions = await context.tracker.getActionsForIntent(intentId);
    expect(actions.length).to.equal(3);

    const movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementActions.length).to.equal(2);
    const origins = new Set(movementActions.map((a) => a.origin));
    expect(origins.has(DOMAIN_IDS.anvil1)).to.be.true;
    expect(origins.has(DOMAIN_IDS.anvil2)).to.be.true;
    movementActions.forEach((a) => {
      expect(a.destination).to.equal(DOMAIN_IDS.anvil3);
      expect(a.status).to.equal('complete');
    });

    const depositActions = actions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositActions.length).to.equal(1);
    const cycle2ActiveIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(cycle2ActiveIntents.length).to.equal(1);
    const cycle2PartialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(cycle2PartialIntents.length).to.equal(1);

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
    const finalPartialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(finalPartialIntents.length).to.equal(0);

    const finalIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(finalIntent?.status).to.equal('complete');
  });
});
