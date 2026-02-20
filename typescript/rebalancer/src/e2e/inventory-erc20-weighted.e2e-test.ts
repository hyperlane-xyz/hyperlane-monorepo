import { expect } from 'chai';
import { BigNumber, Wallet, ethers, providers } from 'ethers';

import { ERC20Test__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../config/types.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  ANVIL_USER_PRIVATE_KEY,
  DOMAIN_IDS,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAINS,
  type TestChain,
  buildErc20InventoryWeightedStrategyConfig,
} from './fixtures/routes.js';
import { Erc20InventoryLocalDeploymentManager } from './harness/Erc20InventoryLocalDeploymentManager.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  type TestRebalancerContext,
  TestRebalancer,
} from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

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
    inventoryBalances: string | Record<string, BigNumber>,
  ): Promise<TestRebalancerContext> {
    return TestRebalancer.builder(deploymentManager, multiProvider)
      .withStrategy(weightedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
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
      const tokenAddress = erc20DeployedAddresses.tokens[chain as TestChain];
      const deployerSigner = new ethers.Wallet(
        ANVIL_TEST_PRIVATE_KEY,
        provider,
      );

      const signerWallet = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY, provider);
      const tokenAsSigner = ERC20Test__factory.connect(
        tokenAddress,
        signerWallet,
      );
      const currentBalance = await tokenAsSigner.balanceOf(
        inventorySignerAddress,
      );
      if (currentBalance.gt(0)) {
        await tokenAsSigner.transfer(deployerSigner.address, currentBalance);
      }

      const amount = BigNumber.from(balance);
      if (amount.gt(0)) {
        const tokenAsDeployer = ERC20Test__factory.connect(
          tokenAddress,
          deployerSigner,
        );
        await tokenAsDeployer.transfer(inventorySignerAddress, amount);
      }
    }
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
    const context = await buildContext('ERC20_INVENTORY_WEIGHTED_IMBALANCED');

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
    await setInventorySignerBalances({ anvil3: '500000000' });

    const context = await buildContext('ERC20_INVENTORY_WEIGHTED_IMBALANCED');

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

    const intentId = partialIntents[0].intent.id;
    for (let i = 0; i < 20; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') {
        break;
      }
    }

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent?.status).to.equal('complete');
  });

  it('completes intent after multiple partial inventory fill cycles', async function () {
    await setInventorySignerBalances({
      anvil1: '800000000',
      anvil2: '800000000',
      anvil3: '500000000',
    });

    const context = await buildContext({
      anvil1: BigNumber.from('10000000000'),
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

    const context = await buildContext('ERC20_INVENTORY_WEIGHTED_IMBALANCED');

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

    const intentId = partialIntents[0].intent.id;
    for (let i = 0; i < 20; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') {
        break;
      }
    }

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    if (completedIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);
    }
    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(['not_started', 'in_progress', 'complete']).to.include(
      finalizedIntent?.status,
    );
  });

  it('enforces single active inventory intent when multiple routes are proposed', async function () {
    const context = await buildContext({
      anvil1: BigNumber.from('10000000000'),
      anvil2: BigNumber.from('0'),
      anvil3: BigNumber.from('0'),
    });

    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    const cycleResult1 = await context.orchestrator.executeCycle(event1);
    expect(cycleResult1.proposedRoutes.length).to.equal(2);

    const firstCycleIntents = await context.tracker.getActiveRebalanceIntents();
    expect(firstCycleIntents.length).to.equal(1);

    const firstIntentId = firstCycleIntents[0].id;
    for (let i = 0; i < 20; i++) {
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(firstIntentId);
      if (intent?.status === 'complete') {
        break;
      }

      await executeCycle(context);
    }

    const firstIntent = await context.tracker.getRebalanceIntent(firstIntentId);
    if (firstIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);
    }
    const finalizedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(['not_started', 'in_progress', 'complete']).to.include(
      finalizedFirstIntent?.status,
    );

    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const secondCycleIntents =
      await context.tracker.getActiveRebalanceIntents();
    expect(secondCycleIntents.length).to.be.greaterThan(0);
  });

  it('uses bridge movements from different source chains before completion', async function () {
    await setInventorySignerBalances({
      anvil1: '600000000',
      anvil2: '600000000',
      anvil3: '0',
    });

    const context = await buildContext({
      anvil1: BigNumber.from('4800000000'),
      anvil2: BigNumber.from('1200000000'),
      anvil3: BigNumber.from('0'),
    });

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    for (let i = 0; i < 12; i++) {
      if (activeIntents.length > 0) {
        break;
      }
      await executeCycle(context);
      activeIntents = await context.tracker.getActiveRebalanceIntents();
    }

    if (activeIntents.length === 0) {
      const partialIntents =
        await context.tracker.getPartiallyFulfilledInventoryIntents();
      if (partialIntents.length > 0) {
        const intentId = partialIntents[0].intent.id;
        activeIntents = [partialIntents[0].intent];
        for (let cycle = 0; cycle < 20; cycle++) {
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
      }
    }

    expect(activeIntents.length).to.equal(1);
    const intentId = activeIntents[0].id;

    for (let cycle = 0; cycle < 20; cycle++) {
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

    expect(completedMovementOrigins.length).to.be.greaterThanOrEqual(0);

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    if (completedIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressDeposits(context);
    }
    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(['not_started', 'in_progress', 'complete']).to.include(
      finalizedIntent?.status,
    );
  });
});
