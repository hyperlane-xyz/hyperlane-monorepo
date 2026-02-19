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
      await context.tracker.syncRebalanceActions();
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
    for (const [chain, provider] of localProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      snapshotIds.set(chain, await snapshot(provider));
    }
    mockBridge.reset();
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

    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.be.greaterThan(0);
    expect(
      movementActions.some(
        (action) =>
          action.origin === DOMAIN_IDS.anvil1 &&
          action.destination === DOMAIN_IDS.anvil3,
      ),
    ).to.be.true;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const movementState = await context.tracker.getRebalanceAction(
      movementActions[0].id,
    );
    expect(movementState?.status).to.equal('complete');

    await executeCycle(context);
    await relayInProgressDeposits(context);

    const completedIntent = await context.tracker.getRebalanceIntent(
      partialIntents[0].intent.id,
    );
    expect(completedIntent?.status).to.equal('complete');
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

    for (let cycle = 0; cycle < 8; cycle++) {
      await executeCycle(context);
      await relayInProgressDeposits(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });

      const activeIntents = await context.tracker.getActiveRebalanceIntents();
      if (activeIntents.length > 0) {
        trackedIntentId = activeIntents[0].id;
      }

      if (trackedIntentId) {
        const intent =
          await context.tracker.getRebalanceIntent(trackedIntentId);
        if (intent?.status === 'complete') {
          break;
        }
      }
    }

    expect(trackedIntentId, 'Inventory intent should exist').to.exist;
    const completedIntent = await context.tracker.getRebalanceIntent(
      trackedIntentId!,
    );
    expect(completedIntent?.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(trackedIntentId!);
    const completedDeposits = actions.filter(
      (action) =>
        action.type === 'inventory_deposit' && action.status === 'complete',
    );
    expect(completedDeposits.length).to.be.greaterThan(1);
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

    await executeCycle(context);

    const movementActions = (
      await context.tracker.getInProgressActions()
    ).filter((action) => action.type === 'inventory_movement');
    expect(movementActions.length).to.be.greaterThan(0);

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

    await executeCycle(context);
    await relayInProgressDeposits(context);

    const completedIntent = await context.tracker.getRebalanceIntent(
      partialIntents[0].intent.id,
    );
    expect(completedIntent?.status).to.equal('complete');
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

    await relayInProgressDeposits(context);

    const firstIntent = await context.tracker.getRebalanceIntent(
      firstCycleIntents[0].id,
    );
    expect(firstIntent?.status).to.equal('complete');

    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const secondCycleIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(secondCycleIntents.length).to.equal(1);
    expect(secondCycleIntents[0].id).to.not.equal(firstCycleIntents[0].id);
    expect(secondCycleIntents[0].destination).to.not.equal(
      firstCycleIntents[0].destination,
    );
  });

  it('uses bridge movements from different source chains before completion', async function () {
    await setInventorySignerBalances({
      anvil1: '600000000000000000',
      anvil2: '600000000000000000',
      anvil3: '0',
    });

    const context = await buildContext({
      anvil1: BigNumber.from('4800000000000000000'),
      anvil2: BigNumber.from('1200000000000000000'),
      anvil3: BigNumber.from('0'),
    });

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    const intentId = activeIntents[0].id;

    for (let cycle = 0; cycle < 6; cycle++) {
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') {
        break;
      }

      await executeCycle(context);
    }

    const actions = await context.tracker.getActionsForIntent(intentId);
    const completedMovementOrigins = actions
      .filter(
        (action) =>
          action.type === 'inventory_movement' && action.status === 'complete',
      )
      .map((action) => action.origin);

    expect(completedMovementOrigins.includes(DOMAIN_IDS.anvil1)).to.be.true;
    expect(completedMovementOrigins.includes(DOMAIN_IDS.anvil2)).to.be.true;

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent?.status).to.equal('complete');
  });
});
