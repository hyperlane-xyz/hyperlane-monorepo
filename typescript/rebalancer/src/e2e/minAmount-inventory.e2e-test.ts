import { expect } from 'chai';
import { BigNumber, providers } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import {
  ScriptedBridgeMock,
  approveInventorySignerForMonitoredRoutes,
  executeInventoryCycle,
  injectInventoryRebalancer,
  inventoryBalances,
  relayInventoryDepositAction,
  setInventorySignerBalances,
} from './harness/InventoryTestHelpers.js';
import {
  type LocalDeploymentContext,
  LocalDeploymentManager,
} from './harness/LocalDeploymentManager.js';
import { TestRebalancer } from './harness/TestRebalancer.js';

describe('MinAmountStrategy Inventory E2E', function () {
  this.timeout(300_000);

  let deploymentManager: LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;
  let inventorySignerAddress: string;
  let minAmountInventoryStrategyConfig: StrategyConfig[];

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
    hyperlaneCore = HyperlaneCore.fromAddressesMap(coreAddresses, multiProvider);

    minAmountInventoryStrategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: {
          anvil1: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
          anvil2: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
          anvil3: {
            minAmount: {
              min: '100',
              target: '120',
              type: RebalancerMinAmountType.Absolute,
            },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
        },
      },
    ];

    inventorySignerAddress = await approveInventorySignerForMonitoredRoutes(
      localProviders,
      deployedAddresses,
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
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('simple transferRemote completes inventory intent', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountInventoryStrategyConfig)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    injectInventoryRebalancer(context, new ScriptedBridgeMock(), inventorySignerAddress);

    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 100_000_000n,
      }),
    );

    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    const intent = activeIntents[0];
    expect(intent.executionMethod).to.equal('inventory');
    expect(intent.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(intent.destination).to.equal(DOMAIN_IDS.anvil2);
    expect(intent.amount).to.equal(70_000_000n);

    const depositActions = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intent.id);
    expect(depositActions.length).to.equal(1);
    expect(depositActions[0].amount).to.equal(70_000_000n);
    expect(depositActions[0].origin).to.equal(DOMAIN_IDS.anvil2);
    expect(depositActions[0].destination).to.equal(DOMAIN_IDS.anvil1);

    await relayInventoryDepositAction(
      depositActions[0],
      context,
      localProviders,
      hyperlaneCore,
    );

    const blockTags = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags);

    const completedIntent = await context.tracker.getRebalanceIntent(intent.id);
    expect(completedIntent!.status).to.equal('complete');
  });

  it('partial transferRemote + bridge + partial transferRemote completes intent', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountInventoryStrategyConfig)
      .withBalances({
        anvil1: BigNumber.from('6000000000'),
        anvil2: BigNumber.from('80000000'),
        anvil3: BigNumber.from('4000000000'),
      })
      .withExecutionMode('execute')
      .build();

    const bridge = new ScriptedBridgeMock();
    bridge.enqueuePlan({
      statusSequence: [
        {
          status: 'complete',
          receivingTxHash: '0x000000000000000000000000000000000000000000000000000000000000beef',
          receivedAmount: 20_000_000n,
        },
      ],
    });
    injectInventoryRebalancer(context, bridge, inventorySignerAddress);

    // Cycle 1: partial transferRemote using existing inventory on deficit chain.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 20_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    const intent = (await context.tracker.getActiveRebalanceIntents())[0];
    expect(intent.amount).to.equal(40_000_000n);

    const cycle1Deposits = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intent.id);
    expect(cycle1Deposits.length).to.equal(1);
    expect(cycle1Deposits[0].amount).to.equal(20_000_000n);

    await relayInventoryDepositAction(
      cycle1Deposits[0],
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    const midIntent = await context.tracker.getRebalanceIntent(intent.id);
    expect(midIntent!.status).to.equal('in_progress');

    // Cycle 2: no destination inventory, trigger LiFi movement.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil3: 100_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    const movementActions = (
      await context.tracker.getActionsByType('inventory_movement')
    ).filter((a) => a.intentId === intent.id);
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].status).to.equal('in_progress');

    // Cycle 3: bridge completed, destination now has inventory for the remainder.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 20_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    const cycle3Deposits = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intent.id);
    expect(cycle3Deposits.length).to.equal(2);

    const latestDeposit = cycle3Deposits.sort((a, b) => a.createdAt - b.createdAt)[1];
    expect(latestDeposit.amount).to.equal(20_000_000n);

    await relayInventoryDepositAction(
      latestDeposit,
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    const completedIntent = await context.tracker.getRebalanceIntent(intent.id);
    expect(completedIntent!.status).to.equal('complete');
  });

  it('loops inventory execution across cycles until intent completion', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountInventoryStrategyConfig)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const bridge = new ScriptedBridgeMock();
    bridge.enqueuePlan({
      statusSequence: [
        {
          status: 'complete',
          receivingTxHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
          receivedAmount: 30_000_000n,
        },
      ],
    });
    bridge.enqueuePlan({
      statusSequence: [
        {
          status: 'complete',
          receivingTxHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
          receivedAmount: 30_000_000n,
        },
      ],
    });
    injectInventoryRebalancer(context, bridge, inventorySignerAddress);

    // Cycle 1: partial deposit (10 USDC).
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 10_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );
    const intentId = (await context.tracker.getActiveRebalanceIntents())[0].id;

    let depositActions = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intentId);
    expect(depositActions.length).to.equal(1);
    expect(depositActions[0].amount).to.equal(10_000_000n);
    await relayInventoryDepositAction(
      depositActions[0],
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    // Cycle 2: trigger first bridge.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil3: 100_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    // Cycle 3: first bridge completed, second partial deposit (30 USDC).
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 30_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );
    depositActions = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intentId);
    expect(depositActions.length).to.equal(2);
    const secondDeposit = depositActions.sort((a, b) => a.createdAt - b.createdAt)[1];
    expect(secondDeposit.amount).to.equal(30_000_000n);
    await relayInventoryDepositAction(
      secondDeposit,
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    // Cycle 4: trigger second bridge.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil1: 100_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    // Cycle 5: second bridge completed, final partial deposit (30 USDC).
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 30_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );
    depositActions = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intentId);
    expect(depositActions.length).to.equal(3);
    const thirdDeposit = depositActions.sort((a, b) => a.createdAt - b.createdAt)[2];
    expect(thirdDeposit.amount).to.equal(30_000_000n);
    await relayInventoryDepositAction(
      thirdDeposit,
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent!.status).to.equal('complete');

    const completedAmount = (
      await context.tracker.getActionsByType('inventory_deposit')
    )
      .filter((a) => a.intentId === intentId)
      .reduce((sum, action) => sum + action.amount, 0n);
    expect(completedAmount).to.equal(70_000_000n);
  });

  it('retries failed bridges in subsequent cycles and keeps single intent', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(minAmountInventoryStrategyConfig)
      .withBalances('BELOW_MIN_ARB')
      .withExecutionMode('execute')
      .build();

    const bridge = new ScriptedBridgeMock();
    bridge.enqueuePlan({ executeError: 'bridge unavailable' });
    bridge.enqueuePlan({
      statusSequence: [{ status: 'failed', error: 'bridge reverted' }],
    });
    bridge.enqueuePlan({
      statusSequence: [
        {
          status: 'complete',
          receivingTxHash: '0x000000000000000000000000000000000000000000000000000000000000cafe',
          receivedAmount: 70_000_000n,
        },
      ],
    });
    injectInventoryRebalancer(context, bridge, inventorySignerAddress);

    // Cycle 1: all bridges fail before any action is created.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil3: 100_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    let intents = await context.tracker.getRebalanceIntentsByDestination(
      DOMAIN_IDS.anvil2,
    );
    expect(intents.length).to.equal(1);
    const intentId = intents[0].id;
    expect(intents[0].status).to.equal('not_started');
    expect((await context.tracker.getActionsByType('inventory_movement')).length).to
      .equal(0);

    // Cycle 2: bridge action created (in-flight).
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );
    intents = await context.tracker.getRebalanceIntentsByDestination(
      DOMAIN_IDS.anvil2,
    );
    expect(intents.length).to.equal(1);
    expect(intents[0].id).to.equal(intentId);
    expect(intents[0].status).to.equal('in_progress');

    let movementActions = (
      await context.tracker.getActionsByType('inventory_movement')
    ).filter((a) => a.intentId === intentId);
    expect(movementActions.length).to.equal(1);
    expect(movementActions[0].status).to.equal('in_progress');

    // Cycle 3: previous in-flight bridge marked failed, intent retried.
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );
    movementActions = (
      await context.tracker.getActionsByType('inventory_movement')
    ).filter((a) => a.intentId === intentId);
    expect(movementActions.length).to.equal(2);
    const sortedMovements = movementActions.sort((a, b) => a.createdAt - b.createdAt);
    expect(sortedMovements[0].status).to.equal('failed');
    expect(sortedMovements[1].status).to.equal('in_progress');

    // Cycle 4: successful retry bridge completed, transferRemote executes.
    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 70_000_000n,
      }),
    );
    await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    const depositActions = (
      await context.tracker.getActionsByType('inventory_deposit')
    ).filter((a) => a.intentId === intentId);
    expect(depositActions.length).to.equal(1);

    await relayInventoryDepositAction(
      depositActions[0],
      context,
      localProviders,
      hyperlaneCore,
    );
    await context.tracker.syncRebalanceActions(await context.getConfirmedBlockTags());

    const completedIntent = await context.tracker.getRebalanceIntent(intentId);
    expect(completedIntent!.status).to.equal('complete');
  });
});
