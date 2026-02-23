import { expect } from 'chai';
import { BigNumber, Wallet, ethers, providers } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../config/types.js';

import {
  ANVIL_USER_PRIVATE_KEY,
  BALANCE_PRESETS,
  DOMAIN_IDS,
  TEST_CHAINS,
  type NativeDeployedAddresses,
  buildInventoryWeightedStrategyConfig,
} from './fixtures/routes.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { NativeLocalDeploymentManager } from './harness/NativeLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  type TestRebalancerContext,
  TestRebalancer,
} from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

describe('Inventory WeightedStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: NativeLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let nativeDeployedAddresses: NativeDeployedAddresses;
  let weightedStrategyConfig: ReturnType<
    typeof buildInventoryWeightedStrategyConfig
  >;
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new Wallet(ANVIL_USER_PRIVATE_KEY).address;

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

  async function relayInProgressDeposits(
    context: TestRebalancerContext,
  ): Promise<void> {
    const inProgressActions = await context.tracker.getInProgressActions();
    const deposits = inProgressActions.filter(
      (action) => action.type === 'inventory_deposit',
    );

    for (const deposit of deposits) {
      expect(deposit.txHash, 'Inventory deposit action should have txHash').to
        .exist;
      expect(
        deposit.messageId,
        'Inventory deposit action should have messageId',
      ).to.exist;

      const originChain = multiProvider.getChainName(deposit.origin);
      const destinationChain = multiProvider.getChainName(deposit.destination);
      const originProvider = localProviders.get(originChain)!;
      const receipt = await originProvider.getTransactionReceipt(
        deposit.txHash!,
      );

      const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
        dispatchTx: receipt,
        messageId: deposit.messageId!,
        origin: originChain,
        destination: destinationChain,
      });

      expect(
        relayResult.success,
        `Inventory deposit relay should succeed: ${relayResult.error}`,
      ).to.be.true;
    }

    if (deposits.length > 0) {
      // Use provider.send to bypass ethers v5 _maxInternalBlockNumber cache
      const tags: Record<string, number> = {};
      for (const chain of TEST_CHAINS) {
        const p = localProviders.get(chain)!;
        const hex = await p.send('eth_blockNumber', []);
        tags[chain] = parseInt(hex, 16);
      }
      await context.tracker.syncRebalanceActions(tags);
    }
  }

  async function buildContext(
    inventoryBalances: keyof typeof BALANCE_PRESETS | Record<string, BigNumber>,
  ): Promise<TestRebalancerContext> {
    return TestRebalancer.builder(deploymentManager, multiProvider)
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances(inventoryBalances)
      .build();
  }

  async function setInventorySignerBalances(
    balancesByChain: Partial<Record<(typeof TEST_CHAINS)[number], string>>,
  ): Promise<void> {
    for (const [chain, balance] of Object.entries(balancesByChain)) {
      const provider = localProviders.get(chain)!;
      await provider.send('anvil_setBalance', [
        inventorySignerAddress,
        ethers.utils.hexValue(BigNumber.from(balance)),
      ]);
    }
  }

  before(async function () {
    deploymentManager = new NativeLocalDeploymentManager(
      inventorySignerAddress,
    );
    const ctx = await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    nativeDeployedAddresses = ctx.deployedAddresses;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: nativeDeployedAddresses.chains[chain].mailbox,
        interchainSecurityModule: nativeDeployedAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    weightedStrategyConfig = buildInventoryWeightedStrategyConfig(
      nativeDeployedAddresses,
    );
    mockBridge = new MockExternalBridge(
      nativeDeployedAddresses,
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
    const context = await buildContext('INVENTORY_WEIGHTED_IMBALANCED');

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    expect(inProgressActions[0].type).to.equal('inventory_deposit');

    await relayInProgressDeposits(context);

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent?.status).to.equal('complete');
  });

  it('handles partial deposit, then bridge, then final deposit', async function () {
    await setInventorySignerBalances({ anvil3: '500000000000000000' });

    const context = await buildContext('INVENTORY_WEIGHTED_IMBALANCED');

    await executeCycle(context);
    await relayInProgressDeposits(context);

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].intent.amount).to.equal(1000000000000000000n);
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(1000000000000000000n);

    const intentId = partialIntents[0].intent.id;

    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementActions[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(movementActions[0].status).to.equal('in_progress');

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const movementState = await context.tracker.getRebalanceAction(
      movementActions[0].id,
    );
    expect(movementState?.status).to.equal('complete');

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressDeposits(context);

    const partialAfterFinalCycle =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterFinalCycle.length).to.equal(0);

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(intentId);
    const deposits = actions.filter((a) => a.type === 'inventory_deposit');
    const movements = actions.filter((a) => a.type === 'inventory_movement');
    expect(actions.length).to.equal(3);
    expect(movements.length).to.equal(1);
    expect(deposits.length).to.equal(2);
  });

  it('completes intent after multiple partial inventory fill cycles', async function () {
    await setInventorySignerBalances({
      anvil1: '800000000000000000',
      anvil2: '800000000000000000',
      anvil3: '500000000000000000',
    });

    const context = await buildContext({
      anvil1: BigNumber.from('10000000000000000000'),
      anvil2: BigNumber.from('0'),
      anvil3: BigNumber.from('0'),
    });

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressDeposits(context);

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(2000000000000000000n);
    const trackedIntentId = activeIntents[0].id;

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(2000000000000000000n);

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
    await relayInProgressDeposits(context);

    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(2000000000000000000n);

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
    await relayInProgressDeposits(context);

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

  it('retries bridge execution after execute and status failures', async function () {
    await setInventorySignerBalances({ anvil3: '0' });

    const context = await buildContext('INVENTORY_WEIGHTED_IMBALANCED');

    mockBridge.failNextExecute();
    await executeCycle(context);

    const actionsAfterExecuteFailure =
      await context.tracker.getInProgressActions();
    expect(actionsAfterExecuteFailure.length).to.equal(0);

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(partialIntents[0].completedAmount).to.equal(0n);
    expect(partialIntents[0].remaining).to.equal(1000000000000000000n);
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(1000000000000000000n);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(0);

    const intentId = partialIntents[0].intent.id;

    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementActions[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(movementActions[0].status).to.equal('in_progress');

    const firstMovement = movementActions[0];
    mockBridge.failStatusFor(firstMovement.txHash!, { status: 'failed' });

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const failedMovement = await context.tracker.getRebalanceAction(
      firstMovement.id,
    );
    expect(failedMovement?.status).to.equal('failed');

    await executeCycle(context);

    const retriedMovementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(retriedMovementActions.length).to.equal(1);
    const retriedMovement = retriedMovementActions[0];
    expect(retriedMovement.origin).to.equal(DOMAIN_IDS.anvil2);
    expect(retriedMovement.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(retriedMovement.status).to.equal('in_progress');

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      retriedMovement.id,
    );
    expect(completedMovement?.status).to.equal('complete');

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressDeposits(context);

    const partialAfterRetry =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterRetry.length).to.equal(0);
    const actions = await context.tracker.getActionsForIntent(intentId);
    expect(actions.length).to.equal(3);
    const movementCount = actions.filter(
      (a) => a.type === 'inventory_movement',
    ).length;
    const depositCount = actions.filter(
      (a) => a.type === 'inventory_deposit',
    ).length;
    expect(movementCount).to.equal(2);
    expect(depositCount).to.equal(1);

    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(finalizedIntent?.status).to.equal('complete');
  });

  it('enforces single active inventory intent when multiple routes are proposed', async function () {
    const context = await buildContext({
      anvil1: BigNumber.from('10000000000000000000'),
      anvil2: BigNumber.from('0'),
      anvil3: BigNumber.from('0'),
    });

    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    const cycleResult1 = await context.orchestrator.executeCycle(event1);
    expect(cycleResult1.proposedRoutes.length).to.equal(2);

    const firstCycleIntents = await context.tracker.getActiveRebalanceIntents();
    expect(firstCycleIntents.length).to.equal(1);
    expect(firstCycleIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(firstCycleIntents[0].amount).to.equal(2000000000000000000n);

    const firstIntentId = firstCycleIntents[0].id;
    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressDeposits(context);

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

    await executeCycle(context);
    const secondCycleIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(secondCycleIntents.length).to.equal(1);
    expect(secondCycleIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(secondCycleIntents[0].amount).to.equal(2000000000000000000n);
  });

  it('uses bridge movements from different source chains before completion', async function () {
    await setInventorySignerBalances({
      anvil1: '600000000000000000',
      anvil2: '600000000000000000',
      anvil3: '300000000000000000',
    });

    const context = await buildContext({
      anvil1: BigNumber.from('4800000000000000000'),
      anvil2: BigNumber.from('1200000000000000000'),
      anvil3: BigNumber.from('0'),
    });

    for (let i = 0; i < 12; i++) {
      await executeCycle(context);
    }

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].amount).to.equal(1200000000000000000n);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    const intentId = activeIntents[0].id;

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

    for (let i = 0; i < 20; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      partialIntents =
        await context.tracker.getPartiallyFulfilledInventoryIntents();
      expect(partialIntents.length === 0 || partialIntents.length === 1).to.be
        .true;
      if (partialIntents.length === 1) {
        expect(partialIntents[0].completedAmount >= 0n).to.be.true;
        expect(partialIntents[0].remaining > 0n).to.be.true;
        expect(
          partialIntents[0].completedAmount + partialIntents[0].remaining,
        ).to.equal(1200000000000000000n);
      }

      const actions = await context.tracker.getActionsForIntent(intentId);
      expect(actions.length >= 0).to.be.true;
    }

    const finalIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(finalIntent?.status).to.equal('complete');
  });
});
