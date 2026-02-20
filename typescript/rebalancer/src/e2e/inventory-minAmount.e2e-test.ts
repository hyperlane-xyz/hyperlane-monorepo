import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';

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
  type NativeDeployedAddresses,
  TEST_CHAINS,
  buildInventoryMinAmountStrategyConfig,
} from './fixtures/routes.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { NativeLocalDeploymentManager } from './harness/NativeLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  TestRebalancerBuilder,
  type TestRebalancerContext,
} from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

describe('InventoryMinAmountStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: NativeLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let nativeDeployedAddresses: NativeDeployedAddresses;
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY)
    .address;
  const oneEth = BigNumber.from('1000000000000000000');
  const twoEth = BigNumber.from('2000000000000000000');

  function chainFromDomain(domain: number): string {
    const found = Object.entries(DOMAIN_IDS).find(([, d]) => d === domain);
    if (!found) {
      throw new Error(`Unknown domain: ${domain}`);
    }
    return found[0];
  }

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

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

  async function setInventorySignerBalance(
    chain: string,
    balance: BigNumber,
  ): Promise<void> {
    const provider = localProviders.get(chain)!;
    await provider.send('anvil_setBalance', [
      inventorySignerAddress,
      ethers.utils.hexValue(balance),
    ]);
  }

  async function relayInProgressInventoryDeposits(
    context: TestRebalancerContext,
  ): Promise<void> {
    const inProgressActions = await context.tracker.getInProgressActions();
    const depositActions = inProgressActions.filter(
      (a) => a.type === 'inventory_deposit' && a.txHash && a.messageId,
    );

    for (const action of depositActions) {
      const origin = chainFromDomain(action.origin);
      const destination = chainFromDomain(action.destination);
      const provider = localProviders.get(origin)!;
      const dispatchTx = await provider.getTransactionReceipt(action.txHash!);

      const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
        dispatchTx,
        messageId: action.messageId!,
        origin,
        destination,
      });

      expect(
        relayResult.success,
        `Inventory deposit relay should succeed: ${relayResult.error}`,
      ).to.be.true;
    }

    // Use provider.send to bypass ethers v5 _maxInternalBlockNumber cache
    // which refuses to return lower block numbers after evm_revert.
    const tags: Record<string, number> = {};
    for (const chain of TEST_CHAINS) {
      const p = localProviders.get(chain)!;
      const hex = await p.send('eth_blockNumber', []);
      tags[chain] = parseInt(hex, 16);
    }
    await context.tracker.syncRebalanceActions(tags);
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
    if (deploymentManager) await deploymentManager.stop();
  });

  it('executes transferRemote when destination collateral is below minimum and inventory exists locally', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(twoEth.toBigInt());

    const inProgressActions = await context.tracker.getInProgressActions();
    const depositAction = inProgressActions.find(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositAction).to.exist;

    await relayInProgressInventoryDeposits(context);

    const completedAction = await context.tracker.getRebalanceAction(
      depositAction!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');
  });

  it('handles partial deposit, bridges inventory, then completes final deposit', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance(
      'anvil2',
      BigNumber.from('500000000000000000'),
    );

    await executeCycle(context);
    await relayInProgressInventoryDeposits(context);

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(2000000000000000000n);
    expect(partialIntents[0].intent.amount).to.equal(2000000000000000000n);
    expect(partialIntents[0].intent.destination).to.equal(DOMAIN_IDS.anvil2);

    await setInventorySignerBalance('anvil2', BigNumber.from(0));

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const activeIntent = partialIntents[0].intent;
    const actionsAfterBridge = await context.tracker.getActionsForIntent(
      activeIntent.id,
    );
    const completedMovementActions = actionsAfterBridge.filter(
      (a) => a.type === 'inventory_movement' && a.status === 'complete',
    );
    expect(completedMovementActions.length).to.equal(1);
    expect(completedMovementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
    expect(completedMovementActions[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(completedMovementActions[0].status).to.equal('complete');

    await executeCycle(context);
    await relayInProgressInventoryDeposits(context);

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntent.id,
    );
    expect(completedIntent!.status).to.equal('complete');
  });

  it('loops across multiple cycles with partial fills before final completion', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil1', oneEth);
    await setInventorySignerBalance(
      'anvil2',
      BigNumber.from('300000000000000000'),
    );
    await setInventorySignerBalance('anvil3', oneEth);

    let targetIntentId: string | undefined;
    for (let i = 0; i < 25; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);

      const activeIntents = await context.tracker.getActiveRebalanceIntents();
      if (!targetIntentId && activeIntents.length > 0) {
        targetIntentId = activeIntents[0].id;
      }
      if (!targetIntentId) continue;

      const intent = await context.tracker.getRebalanceIntent(targetIntentId);
      if (intent?.status === 'complete') break;
    }

    expect(targetIntentId).to.exist;

    for (let i = 0; i < 5; i++) {
      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(targetIntentId!);
      if (intent?.status === 'complete') break;
    }

    const finalIntent = await context.tracker.getRebalanceIntent(
      targetIntentId!,
    );
    expect(finalIntent!.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(targetIntentId!);
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
      expect(movement.destination).to.equal(DOMAIN_IDS.anvil2);
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

  it('retries after bridge execution failure and bridge status failure', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil1', twoEth);
    await setInventorySignerBalance('anvil2', BigNumber.from(0));
    await setInventorySignerBalance('anvil3', BigNumber.from(0));

    mockBridge.failNextExecute();
    await executeCycle(context);

    expect((await context.tracker.getActiveRebalanceIntents()).length).to.equal(
      0,
    );

    for (let i = 0; i < 12; i++) {
      await executeCycle(context);
      expect(
        (await context.tracker.getActiveRebalanceIntents()).length,
      ).to.equal(0);
    }

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount).to.equal(0n);
    expect(partialIntents[0].remaining).to.equal(2000000000000000000n);
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(2000000000000000000n);

    const intentId = partialIntents[0].intent.id;

    for (let i = 0; i < 8; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      const actions = await context.tracker.getActionsForIntent(intentId);
      expect(actions.length).to.equal(0);
      expect(
        actions.filter((a) => a.type === 'inventory_movement').length,
      ).to.equal(0);
      expect(
        actions.filter((a) => a.type === 'inventory_deposit').length,
      ).to.equal(0);
    }

    const actionsAfterSearch =
      await context.tracker.getActionsForIntent(intentId);
    expect(
      actionsAfterSearch.filter((a) => a.type === 'inventory_movement').length,
    ).to.equal(0);
  });

  it('enforces single active inventory intent when multiple deficit chains exist', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances({
        anvil1: BigNumber.from('6000000000000000000'),
        anvil2: BigNumber.from(0),
        anvil3: BigNumber.from(0),
      })
      .withExecutionMode('execute')
      .build();

    await executeCycle(context);

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(2000000000000000000n);
    const firstIntentId = activeIntents[0].id;

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(0);

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
    await relayInProgressInventoryDeposits(context);

    for (let i = 0; i < 5; i++) {
      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(firstIntentId);
      if (intent?.status === 'complete') break;
    }

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(completedFirstIntent!.status).to.equal('complete');

    const activeIntentsAfterFirst =
      await context.tracker.getActiveRebalanceIntents();
    if (activeIntentsAfterFirst.length === 0) {
      await executeCycle(context);
    }
    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil3);
    expect(activeIntents[0].amount).to.equal(2000000000000000000n);
  });

  it('uses multiple bridge movements from different sources before completing deposit', async function () {
    const context = await new TestRebalancerBuilder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(
        buildInventoryMinAmountStrategyConfig(nativeDeployedAddresses),
      )
      .withInventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        nativeDeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance(
      'anvil1',
      BigNumber.from('1200000000000000000'),
    );
    await setInventorySignerBalance('anvil2', BigNumber.from(0));
    await setInventorySignerBalance(
      'anvil3',
      BigNumber.from('1200000000000000000'),
    );

    let intentId: string | undefined;
    for (let i = 0; i < 15; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);

      const activeIntents = await context.tracker.getActiveRebalanceIntents();
      if (!intentId && activeIntents.length > 0) {
        intentId = activeIntents[0].id;
        expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
        expect(activeIntents[0].amount).to.equal(2000000000000000000n);
      }
      if (!intentId) continue;

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') break;
    }

    expect(intentId).to.exist;

    for (let i = 0; i < 5; i++) {
      await confirmDeliveries(context);
      const intent = await context.tracker.getRebalanceIntent(intentId!);
      if (intent?.status === 'complete') break;
    }

    const finalIntent = await context.tracker.getRebalanceIntent(intentId!);
    expect(finalIntent!.status).to.equal('complete');

    const actions = await context.tracker.getActionsForIntent(intentId!);
    expect(actions.length).to.be.at.least(3);
    const movementActions = actions.filter(
      (a) => a.type === 'inventory_movement',
    );
    const depositActions = actions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(movementActions.length).to.be.at.least(1);
    expect(depositActions.length).to.be.at.least(1);
    expect(movementActions.length + depositActions.length).to.equal(
      actions.length,
    );

    for (const movement of movementActions) {
      expect(movement.destination).to.equal(DOMAIN_IDS.anvil2);
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
});
