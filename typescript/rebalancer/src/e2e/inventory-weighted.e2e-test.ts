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

  async function confirmDeliveries(
    context: TestRebalancerContext,
  ): Promise<void> {
    const tags: Record<string, number> = {};
    for (const chain of TEST_CHAINS) {
      const p = localProviders.get(chain)!;
      const hex = await p.send('eth_blockNumber', []);
      tags[chain] = parseInt(hex, 16);
    }
    await context.tracker.syncRebalanceActions(tags);
  }

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

    // Cycle 1: partial deposit with limited inventory signer balance
    await executeCycle(context);
    await relayInProgressDeposits(context);

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(partialIntents[0].intent.amount);

    const intentId = partialIntents[0].intent.id;

    // Cycle 2: bridge movement to get more inventory to anvil3
    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementActions[0].destination).to.equal(DOMAIN_IDS.anvil3);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const movementState = await context.tracker.getRebalanceAction(
      movementActions[0].id,
    );
    expect(movementState?.status).to.equal('complete');

    // Cycle 3+: final deposit to complete the intent
    for (let i = 0; i < 10; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') break;
    }

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(intentId);
    const deposits = actions.filter((a) => a.type === 'inventory_deposit');
    const movements = actions.filter((a) => a.type === 'inventory_movement');
    expect(deposits.length).to.be.at.least(2);
    expect(movements.length).to.be.at.least(1);
    for (const d of deposits) expect(d.status).to.equal('complete');
    for (const m of movements) {
      expect(m.status).to.equal('complete');
      expect(m.destination).to.equal(DOMAIN_IDS.anvil3);
    }
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

    let trackedIntentId: string | undefined;

    for (let cycle = 0; cycle < 15; cycle++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const activeIntents = await context.tracker.getActiveRebalanceIntents();
      if (!trackedIntentId && activeIntents.length > 0) {
        trackedIntentId = activeIntents[0].id;
      }
      if (!trackedIntentId) continue;

      const intent = await context.tracker.getRebalanceIntent(trackedIntentId);
      if (intent?.status === 'complete') break;
    }

    expect(trackedIntentId, 'Inventory intent should exist').to.exist;

    for (let i = 0; i < 5; i++) {
      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(trackedIntentId!);
      if (intent?.status === 'complete') break;
    }

    const completedIntent = await context.tracker.getRebalanceIntent(
      trackedIntentId!,
    );
    expect(completedIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(trackedIntentId!);
    expect(actions.length).to.be.at.least(3);
    const movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    const depositActions = actions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(movementActions.length).to.be.at.least(1);
    expect(depositActions.length).to.be.at.least(2);
    expect(movementActions.length + depositActions.length).to.equal(
      actions.length,
    );

    for (const movement of movementActions) {
      expect(movement.status).to.equal('complete');
      expect(
        movement.origin === DOMAIN_IDS.anvil1 ||
          movement.origin === DOMAIN_IDS.anvil3,
      ).to.be.true;
    }
    for (const deposit of depositActions) {
      expect(deposit.status).to.equal('complete');
    }
  });

  it('retries bridge execution after execute and status failures', async function () {
    await setInventorySignerBalances({ anvil3: '0' });

    const context = await buildContext('INVENTORY_WEIGHTED_IMBALANCED');

    // Cycle 1: bridge execute fails — no actions created
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
    expect(partialIntents[0].remaining > 0n).to.be.true;

    const intentId = partialIntents[0].intent.id;

    // Cycle 2: bridge succeeds but status check fails
    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(movementActions[0].destination).to.equal(DOMAIN_IDS.anvil3);

    const firstMovement = movementActions[0];
    mockBridge.failStatusFor(firstMovement.txHash!, { status: 'failed' });

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const failedMovement = await context.tracker.getRebalanceAction(
      firstMovement.id,
    );
    expect(failedMovement?.status).to.equal('failed');

    // Cycle 3: retry creates new movement
    await executeCycle(context);

    const retriedMovement = (await context.tracker.getInProgressActions()).find(
      (action) =>
        action.type === 'inventory_movement' && action.id !== firstMovement.id,
    );
    expect(retriedMovement, 'Retry should create a new movement action').to
      .exist;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      retriedMovement!.id,
    );
    expect(completedMovement?.status).to.equal('complete');

    // Complete the intent
    for (let i = 0; i < 10; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') break;
    }

    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(finalizedIntent?.status).to.equal('complete');
  });

  it('enforces single active inventory intent when multiple routes are proposed', async function () {
    const context = await buildContext({
      anvil1: BigNumber.from('10000000000000000000'),
      anvil2: BigNumber.from('0'),
      anvil3: BigNumber.from('0'),
    });

    // Cycle 1: two routes proposed but only one intent created
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    const cycleResult1 = await context.orchestrator.executeCycle(event1);
    expect(cycleResult1.proposedRoutes.length).to.equal(2);

    const firstCycleIntents = await context.tracker.getActiveRebalanceIntents();
    expect(firstCycleIntents.length).to.equal(1);

    const firstIntentId = firstCycleIntents[0].id;
    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

    // Complete the first intent
    for (let i = 0; i < 20; i++) {
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(firstIntentId);
      if (intent?.status === 'complete') break;

      await executeCycle(context);
    }

    for (let i = 0; i < 5; i++) {
      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(firstIntentId);
      if (intent?.status === 'complete') break;
    }

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(completedFirstIntent?.status).to.equal('complete');

    // After first completes, second intent can be created
    const activeIntentsAfterFirst =
      await context.tracker.getActiveRebalanceIntents();
    if (activeIntentsAfterFirst.length === 0) {
      await executeCycle(context);
    }
    const secondCycleIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(secondCycleIntents.length).to.equal(1);
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

    let intentId: string | undefined;

    for (let i = 0; i < 25; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      if (!intentId) {
        const activeIntents = await context.tracker.getActiveRebalanceIntents();
        if (activeIntents.length > 0) {
          intentId = activeIntents[0].id;
        }
      }
      if (!intentId) {
        const partialIntents =
          await context.tracker.getPartiallyFulfilledInventoryIntents();
        if (partialIntents.length > 0) {
          intentId = partialIntents[0].intent.id;
        }
      }
      if (!intentId) continue;

      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') break;
    }

    expect(intentId).to.exist;

    const finalIntent = await context.tracker.getRebalanceIntent(intentId!);
    expect(finalIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(intentId!);
    expect(actions.length).to.be.at.least(2);
    const movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    const depositActions = actions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(movementActions.length + depositActions.length).to.equal(
      actions.length,
    );

    for (const movement of movementActions) {
      expect(movement.status).to.equal('complete');
      expect(
        movement.origin === DOMAIN_IDS.anvil1 ||
          movement.origin === DOMAIN_IDS.anvil2,
      ).to.be.true;
    }
    for (const deposit of depositActions) {
      expect(deposit.status).to.equal('complete');
    }
  });
});
