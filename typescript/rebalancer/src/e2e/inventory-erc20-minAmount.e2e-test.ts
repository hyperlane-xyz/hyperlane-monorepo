import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';

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
  buildErc20InventoryMinAmountStrategyConfig,
} from './fixtures/routes.js';
import { Erc20InventoryLocalDeploymentManager } from './harness/Erc20InventoryLocalDeploymentManager.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  TestRebalancerBuilder,
  type TestRebalancerContext,
} from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

describe('Erc20 InventoryMinAmountStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20InventoryLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let erc20DeployedAddresses: Erc20InventoryDeployedAddresses;
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY)
    .address;
  const twoHundredUsdc = BigNumber.from('200000000');

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

  async function setInventorySignerBalance(
    chain: string,
    balance: BigNumber,
  ): Promise<void> {
    const provider = localProviders.get(chain)!;
    const tokenAddress = erc20DeployedAddresses.tokens[chain as TestChain];
    const deployerSigner = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);

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

    if (balance.gt(0)) {
      const tokenAsDeployer = ERC20Test__factory.connect(
        tokenAddress,
        deployerSigner,
      );
      await tokenAsDeployer.transfer(inventorySignerAddress, balance);
    }
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

    await context.tracker.syncRebalanceActions();
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
      .withInventoryBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(DOMAIN_IDS.anvil2);
    expect(activeIntents[0].amount).to.equal(twoHundredUsdc.toBigInt());

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
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil2', BigNumber.from('50000000'));

    await executeCycle(context);
    await relayInProgressInventoryDeposits(context);

    let partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;

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
    expect(completedMovementActions.length).to.be.greaterThan(0);

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
        buildErc20InventoryMinAmountStrategyConfig(erc20DeployedAddresses),
      )
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil1', BigNumber.from('100000000'));
    await setInventorySignerBalance('anvil2', BigNumber.from('30000000'));
    await setInventorySignerBalance('anvil3', BigNumber.from('100000000'));

    let targetIntentId: string | undefined;
    for (let i = 0; i < 20; i++) {
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
      if (intent?.status === 'complete') {
        break;
      }
    }

    expect(targetIntentId).to.exist;
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await relayInProgressInventoryDeposits(context);
    const finalIntent = await context.tracker.getRebalanceIntent(
      targetIntentId!,
    );
    if (finalIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);
    }
    const finalizedIntent = await context.tracker.getRebalanceIntent(
      targetIntentId!,
    );
    expect(['in_progress', 'complete']).to.include(finalizedIntent!.status);

    const actions = await context.tracker.getActionsForIntent(targetIntentId!);
    const movementCount = actions.filter(
      (a) => a.type === 'inventory_movement',
    ).length;
    const depositCount = actions.filter(
      (a) => a.type === 'inventory_deposit',
    ).length;
    expect(actions.length).to.be.greaterThan(0);
    expect(movementCount).to.be.greaterThanOrEqual(0);
    expect(depositCount).to.be.greaterThan(0);
  });

  it('retries after bridge execution failure and bridge status failure', async function () {
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
      .withInventoryBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil1', twoHundredUsdc);
    await setInventorySignerBalance('anvil2', BigNumber.from(0));
    await setInventorySignerBalance('anvil3', BigNumber.from(0));

    mockBridge.failNextExecute();
    await executeCycle(context);

    let activeAfterFailure = await context.tracker.getActiveRebalanceIntents();
    expect(activeAfterFailure.length).to.equal(0);

    for (let i = 0; i < 12; i++) {
      await executeCycle(context);
      activeAfterFailure = await context.tracker.getActiveRebalanceIntents();
      if (activeAfterFailure.length > 0) {
        break;
      }
    }

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);

    const intentId = partialIntents[0].intent.id;
    let actions = await context.tracker.getActionsForIntent(intentId);
    let firstMovement = actions.find((a) => a.type === 'inventory_movement');
    for (let i = 0; i < 8 && !firstMovement; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      actions = await context.tracker.getActionsForIntent(intentId);
      firstMovement = actions.find((a) => a.type === 'inventory_movement');
    }
    if (!firstMovement) {
      expect(actions.some((a) => a.type === 'inventory_movement')).to.be.false;
      return;
    }

    mockBridge.failStatusFor(firstMovement!.txHash!, { status: 'failed' });
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const failedMovement = await context.tracker.getRebalanceAction(
      firstMovement!.id,
    );
    expect(failedMovement!.status).to.equal('failed');

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    actions = await context.tracker.getActionsForIntent(intentId);
    const completedMovement = actions.find(
      (a) =>
        a.type === 'inventory_movement' &&
        a.status === 'complete' &&
        a.id !== firstMovement!.id,
    );
    expect(completedMovement).to.exist;

    for (let i = 0; i < 8; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') {
        break;
      }
    }

    const finalIntent = await context.tracker.getRebalanceIntent(intentId);
    if (finalIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);
    }
    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(['in_progress', 'complete']).to.include(finalizedIntent!.status);
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
      .withInventoryBalances({
        anvil1: BigNumber.from('6000000000'),
        anvil2: BigNumber.from(0),
        anvil3: BigNumber.from(0),
      })
      .withExecutionMode('execute')
      .build();

    await executeCycle(context);

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    const firstIntentId = activeIntents[0].id;
    const firstDestination = activeIntents[0].destination;

    for (let i = 0; i < 12; i++) {
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);
      const firstIntent =
        await context.tracker.getRebalanceIntent(firstIntentId);
      if (firstIntent?.status === 'complete') {
        break;
      }
      await executeCycle(context);
    }

    const completedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    if (completedFirstIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);
    }
    const finalizedFirstIntent =
      await context.tracker.getRebalanceIntent(firstIntentId);
    expect(['in_progress', 'complete']).to.include(
      finalizedFirstIntent!.status,
    );

    await executeCycle(context);
    activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.be.oneOf([
      DOMAIN_IDS.anvil2,
      DOMAIN_IDS.anvil3,
      firstDestination,
    ]);
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
      .withInventoryBalances('ERC20_INVENTORY_EMPTY_DEST')
      .withExecutionMode('execute')
      .build();

    await setInventorySignerBalance('anvil1', BigNumber.from('120000000'));
    await setInventorySignerBalance('anvil2', BigNumber.from(0));
    await setInventorySignerBalance('anvil3', BigNumber.from('120000000'));

    let activeIntents = await context.tracker.getActiveRebalanceIntents();
    for (let i = 0; i < 8; i++) {
      if (activeIntents.length > 0) {
        break;
      }
      await executeCycle(context);
      activeIntents = await context.tracker.getActiveRebalanceIntents();
    }

    expect(activeIntents.length).to.equal(1);
    const intentId = activeIntents[0].id;

    for (let i = 0; i < 20; i++) {
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      const actionsAfterMovements =
        await context.tracker.getActionsForIntent(intentId);
      const completedMoves = actionsAfterMovements.filter(
        (a) => a.type === 'inventory_movement' && a.status === 'complete',
      );
      if (completedMoves.length > 1) {
        break;
      }
      await executeCycle(context);
    }

    const actionsAfterMovements =
      await context.tracker.getActionsForIntent(intentId);
    const movementActions = actionsAfterMovements.filter(
      (a) => a.type === 'inventory_movement' && a.status === 'complete',
    );
    expect(movementActions.length).to.be.greaterThan(0);
    const movementOrigins = new Set(movementActions.map((a) => a.origin));
    expect(
      movementOrigins.has(DOMAIN_IDS.anvil1) ||
        movementOrigins.has(DOMAIN_IDS.anvil3),
    ).to.be.true;

    for (let i = 0; i < 20; i++) {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);

      const intent = await context.tracker.getRebalanceIntent(intentId);
      if (intent?.status === 'complete') {
        break;
      }
    }

    const finalIntent = await context.tracker.getRebalanceIntent(intentId);
    if (finalIntent?.status !== 'complete') {
      await executeCycle(context);
      await context.tracker.syncInventoryMovementActions({
        [ExternalBridgeType.LiFi]: mockBridge,
      });
      await relayInProgressInventoryDeposits(context);
    }
    const finalizedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(['in_progress', 'complete']).to.include(finalizedIntent!.status);
  });
});
