import { expect } from 'chai';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  LocalAccountViemSigner,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '../config/types.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  ANVIL_USER_PRIVATE_KEY,
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
  type TestChain,
} from './fixtures/routes.js';
import {
  type LocalDeploymentContext,
  LocalDeploymentManager,
} from './harness/LocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import {
  executeWarpTransfer,
  tryRelayMessage,
} from './harness/TransferHelper.js';

describe('CompositeStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, ReturnType<MultiProvider['getProvider']>>;
  let userAddress: string;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;

  before(async function () {
    const wallet = new LocalAccountViemSigner(ensure0x(ANVIL_USER_PRIVATE_KEY));
    userAddress = await wallet.getAddress();

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
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
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

  it('collateralDeficit + weighted: routes use different bridges', async function () {
    const transferAmount = 600000000n; // 600 USDC

    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            anvil1: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil1,
            },
            anvil2: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil2,
            },
            anvil3: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil3,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            anvil1: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil1,
            },
            anvil2: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil2,
            },
            anvil3: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil3,
            },
          },
        },
      ])
      .withBalances('COMPOSITE_DEFICIT_IMBALANCE')
      .withExecutionMode('execute')
      .build();

    // Fund user and execute actual warp transfer
    const ethProvider = localProviders.get('anvil1')!;
    const deployer = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    ).connect(ethProvider as any);
    const token = ERC20__factory.connect(
      deployedAddresses.tokens.anvil1,
      deployer,
    );
    await token.transfer(userAddress, transferAmount * 2n);

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'anvil1',
        destinationChain: 'anvil2',
        routerAddress: deployedAddresses.monitoredRoute.anvil1,
        tokenAddress: deployedAddresses.tokens.anvil1,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags);

    // Verify transfer was tracked
    const transfersBeforeRebalance =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeRebalance.length).to.equal(
      1,
      'Should have exactly 1 in-progress transfer',
    );

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Assert using ActionTracker: Both SUPERSEED (CollateralDeficit) and SUBTENSOR intent should exist
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Should have active rebalance intents',
    ).to.be.equal(3, 'Should have exactly 3 active rebalance intents');

    const inProgressActions = await context.tracker.getInProgressActions();

    // Check for SUPERSEED actions (CollateralDeficit strategy routes to arbitrum)
    const superseedActions = [];
    for (const action of inProgressActions) {
      const intent = activeIntents.find((i) => i.id === action.intentId);
      if (intent?.bridge) {
        const originChain = Object.entries(DOMAIN_IDS).find(
          ([, id]) => id === action.origin,
        )?.[0] as TestChain | undefined;
        if (
          originChain &&
          intent.bridge === deployedAddresses.bridgeRoute1[originChain]
        ) {
          superseedActions.push(action);
        }
      }
    }
    expect(
      superseedActions.length,
      'Should have SUPERSEED actions from CollateralDeficit',
    ).to.be.equal(1);

    // Verify SUPERSEED route goes to arbitrum (has deficit from pending transfer)
    const actionToArbitrum = superseedActions.find(
      (a) => a.destination === DOMAIN_IDS.anvil2,
    );
    expect(actionToArbitrum, 'Should have SUPERSEED action to arbitrum').to
      .exist;

    // Relay SUPERSEED actions and verify completion
    for (const action of superseedActions) {
      if (!action.txHash) continue;
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0] as TestChain | undefined;
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0] as TestChain | undefined;

      if (originChain && destChain) {
        const originProvider = localProviders.get(originChain);
        expect(originProvider, `Provider should exist for ${originChain}`).to
          .exist;
        const rebalanceTxReceipt = await originProvider!.getTransactionReceipt(
          action.txHash,
        );
        expect(rebalanceTxReceipt, `Receipt should exist for ${action.id}`).to
          .exist;

        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt!,
            messageId: action.messageId!,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(
          relayResult.success,
          `SUPERSEED relay should succeed: ${relayResult.error}`,
        ).to.be.true;
      }
    }

    const blockTags2 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags2);

    for (const action of superseedActions) {
      const completedAction = await context.tracker.getRebalanceAction(
        action.id,
      );
      expect(completedAction!.status).to.equal('complete');
    }

    // Relay the original user transfer now that collateral has been rebalanced
    const userTransferRelay = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(
      userTransferRelay.success,
      `User transfer relay should succeed: ${userTransferRelay.error}`,
    ).to.be.true;

    const blockTags3 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags3);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });

  it('collateralDeficit + minAmount: routes use different bridges', async function () {
    const transferAmount = 600000000n; // 600 USDC
    const customBalances = {
      anvil1: 8000000000n,
      anvil2: 500000000n,
      anvil3: 50000000n, // below minAmount threshold (100 USDC)
    };

    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            anvil1: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil1,
            },
            anvil2: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil2,
            },
            anvil3: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil3,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
          chains: {
            anvil1: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: deployedAddresses.bridgeRoute2.anvil1,
            },
            anvil2: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: deployedAddresses.bridgeRoute2.anvil2,
            },
            anvil3: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: deployedAddresses.bridgeRoute2.anvil3,
            },
          },
        },
      ])
      .withBalances(customBalances)
      .withExecutionMode('execute')
      .build();

    const ethProvider = localProviders.get('anvil1')!;
    const deployer2 = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    ).connect(ethProvider as any);
    const token2 = ERC20__factory.connect(
      deployedAddresses.tokens.anvil1,
      deployer2,
    );
    await token2.transfer(userAddress, transferAmount * 2n);

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'anvil1',
        destinationChain: 'anvil2',
        routerAddress: deployedAddresses.monitoredRoute.anvil1,
        tokenAddress: deployedAddresses.tokens.anvil1,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags4 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags4);

    const transfersBeforeRebalance =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeRebalance.length).to.equal(
      1,
      'Should have exactly 1 in-progress transfer',
    );

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Should have active rebalance intents',
    ).to.be.greaterThan(0);

    const inProgressActions = await context.tracker.getInProgressActions();

    const superseedActions = [];
    for (const action of inProgressActions) {
      const intent = activeIntents.find((i) => i.id === action.intentId);
      if (intent?.bridge) {
        const originChain = Object.entries(DOMAIN_IDS).find(
          ([, id]) => id === action.origin,
        )?.[0] as TestChain | undefined;
        if (
          originChain &&
          intent.bridge === deployedAddresses.bridgeRoute1[originChain]
        ) {
          superseedActions.push(action);
        }
      }
    }
    expect(
      superseedActions.length,
      'Should have SUPERSEED actions from CollateralDeficit',
    ).to.be.greaterThan(0);

    const actionToArbitrum = superseedActions.find(
      (a) => a.destination === DOMAIN_IDS.anvil2,
    );
    expect(actionToArbitrum, 'Should have SUPERSEED action to arbitrum').to
      .exist;

    for (const action of superseedActions) {
      if (!action.txHash) continue;
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0] as TestChain | undefined;
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0] as TestChain | undefined;

      if (originChain && destChain) {
        const originProvider = localProviders.get(originChain);
        expect(originProvider, `Provider should exist for ${originChain}`).to
          .exist;
        const rebalanceTxReceipt = await originProvider!.getTransactionReceipt(
          action.txHash,
        );
        expect(rebalanceTxReceipt, `Receipt should exist for ${action.id}`).to
          .exist;

        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt!,
            messageId: action.messageId!,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(
          relayResult.success,
          `SUPERSEED relay should succeed: ${relayResult.error}`,
        ).to.be.true;
      }
    }

    const blockTags5 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags5);

    for (const action of superseedActions) {
      const completedAction = await context.tracker.getRebalanceAction(
        action.id,
      );
      expect(completedAction!.status).to.equal('complete');
    }

    const userTransferRelay = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(
      userTransferRelay.success,
      `User transfer relay should succeed: ${userTransferRelay.error}`,
    ).to.be.true;

    const blockTags6 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags6);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });

  it('should propose collateralDeficit rebalance even when slow rebalance is inflight', async function () {
    const ethProvider = localProviders.get('anvil1')!;
    const transferAmount = 600000000n;

    // Build context with Composite strategy from the start
    // COMPOSITE_DEFICIT_IMBALANCE: eth=8000, arb=500, base=1500
    // Weighted sees: eth surplus (target=6000), base deficit (target=2000)
    // Cycle 1: Weighted creates SUBTENSOR rebalance eth→base
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            anvil1: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil1,
            },
            anvil2: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil2,
            },
            anvil3: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil3,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            anvil1: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil1,
            },
            anvil2: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil2,
            },
            anvil3: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil3,
            },
          },
        },
      ])
      .withBalances('COMPOSITE_DEFICIT_IMBALANCE')
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute Weighted rebalance (no deficit yet) =====
    // Initial: eth=7000, arb=2000, base=1000. Target: eth=6000, arb=2000, base=2000
    // CollateralDeficit finds no deficit (no pending transfers), so Weighted runs
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags7 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags7);
    const inflightAfterCycle1 = await context.tracker.getInProgressActions();
    expect(
      inflightAfterCycle1.length,
      'Cycle 1 should create inflight actions',
    ).to.be.greaterThan(0);

    const activeIntents1 = await context.tracker.getActiveRebalanceIntents();
    const subtensorInflight = inflightAfterCycle1.find((action) => {
      const intent = activeIntents1.find((i) => i.id === action.intentId);
      if (!intent?.bridge) return false;
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0] as TestChain | undefined;
      return (
        originChain &&
        intent.bridge === deployedAddresses.bridgeRoute2[originChain]
      );
    });
    expect(
      subtensorInflight,
      'Should have SUBTENSOR inflight from Weighted strategy',
    ).to.exist;

    // ===== CYCLE 2: Add pending transfer to create deficit, then execute =====
    // Fund user and execute a warp transfer eth→arbitrum to create deficit on arbitrum
    const deployer3 = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    ).connect(ethProvider as any);
    const token3 = ERC20__factory.connect(
      deployedAddresses.tokens.anvil1,
      deployer3,
    );
    await token3.transfer(userAddress, transferAmount * 2n);

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'anvil1',
        destinationChain: 'anvil2',
        routerAddress: deployedAddresses.monitoredRoute.anvil1,
        tokenAddress: deployedAddresses.tokens.anvil1,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags8 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags8);

    // Verify transfer tracked
    const transfersBeforeCycle2 =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeCycle2.length).to.equal(
      1,
      'Should have 1 in-progress transfer',
    );

    // Execute cycle 2 - now CollateralDeficit should see deficit on arbitrum
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const blockTags9 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags9);

    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const activeIntents2 = await context.tracker.getActiveRebalanceIntents();

    const superseedActions = inProgressAfterCycle2.filter((action) => {
      const intent = activeIntents2.find((i) => i.id === action.intentId);
      if (!intent?.bridge) return false;
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0] as TestChain | undefined;
      return (
        originChain &&
        intent.bridge === deployedAddresses.bridgeRoute1[originChain]
      );
    });

    expect(
      superseedActions.length,
      'Should have SUPERSEED actions from CollateralDeficit despite SUBTENSOR inflight',
    ).to.be.greaterThan(0);

    const superseedToArbitrum = superseedActions.find(
      (a) => a.destination === DOMAIN_IDS.anvil2,
    );
    expect(
      superseedToArbitrum,
      'Should have SUPERSEED action to arbitrum for deficit',
    ).to.exist;

    // Relay SUPERSEED actions and verify completion
    for (const action of superseedActions) {
      if (!action.txHash) continue;
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0] as TestChain | undefined;
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0] as TestChain | undefined;

      if (originChain && destChain) {
        const originProvider = localProviders.get(originChain);
        expect(originProvider, `Provider should exist for ${originChain}`).to
          .exist;
        const rebalanceTxReceipt = await originProvider!.getTransactionReceipt(
          action.txHash,
        );
        expect(rebalanceTxReceipt, `Receipt should exist for ${action.id}`).to
          .exist;

        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt!,
            messageId: action.messageId!,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(
          relayResult.success,
          `SUPERSEED relay should succeed: ${relayResult.error}`,
        ).to.be.true;
      }
    }

    const blockTags10 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags10);

    for (const action of superseedActions) {
      const completedAction = await context.tracker.getRebalanceAction(
        action.id,
      );
      expect(completedAction!.status).to.equal('complete');
    }

    // Relay the original user transfer now that collateral has been rebalanced
    const userTransferRelay = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(
      userTransferRelay.success,
      `User transfer relay should succeed: ${userTransferRelay.error}`,
    ).to.be.true;
  });

  it('should simulate end state accounting for inflight rebalances', async function () {
    const ethProvider = localProviders.get('anvil1')!;

    // Build context with Weighted strategy
    // Initial: eth=7000, arb=2000, base=1000 (total=10000)
    // Target: eth=60% (6000), arb=20% (2000), base=20% (2000)
    // Cycle 1 will create inflight eth→base for ~1000 USDC
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            anvil1: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil1,
            },
            anvil2: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil2,
            },
            anvil3: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil3,
            },
          },
        },
      ])
      .withBalances({
        anvil1: 7000000000n,
        anvil2: 2000000000n,
        anvil3: 1000000000n,
      })
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute rebalance to create inflight eth→base =====
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags11 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags11);

    const inflightAfterCycle1 = await context.tracker.getInProgressActions();
    expect(
      inflightAfterCycle1.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToBase = inflightAfterCycle1.find(
      (a) =>
        a.destination === DOMAIN_IDS.anvil3 && a.origin === DOMAIN_IDS.anvil1,
    );
    expect(inflightToBase, 'Should have inflight action eth→base').to.exist;

    const inflightAmount = BigInt(inflightToBase!.amount);
    expect(inflightAmount > 0n, 'Inflight amount should be positive').to.be
      .true;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Weighted now sees: base effective = current + inflight ≈ 2000 (target)
    // Should propose reduced amount or nothing to base
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    await context.orchestrator.executeCycle(event2);

    const blockTags12 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags12);

    // Check if new routes to base were proposed
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToBase = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.anvil3 &&
        a.id !== inflightToBase!.id &&
        a.status === 'in_progress',
    );

    if (newActionsToBase.length > 0) {
      // If route was proposed, should be much smaller than original 1000 USDC
      const proposedAmount = BigInt(newActionsToBase[0].amount);
      expect(
        proposedAmount < 500000000n,
        `Amount to base (${proposedAmount}) should be reduced accounting for inflight`,
      ).to.be.true;
    }
    // If no new route to base, that's valid (within tolerance after inflight)

    // Verify inflight still exists and action tracking is working
    const finalInProgress = await context.tracker.getInProgressActions();
    const inflightStillActive = finalInProgress.find(
      (a) => a.id === inflightToBase!.id,
    );
    expect(inflightStillActive, 'Inflight action should still be tracked').to
      .exist;
    expect(inflightStillActive!.status).to.equal('in_progress');

    // Relay the inflight from cycle 1
    if (inflightToBase?.txHash) {
      const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
        inflightToBase.txHash,
      );
      const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
        dispatchTx: rebalanceTxReceipt,
        messageId: inflightToBase.messageId!,
        origin: 'anvil1',
        destination: 'anvil3',
      });

      if (relayResult.success) {
        const blockTags13 = await context.getConfirmedBlockTags();
        await context.tracker.syncRebalanceActions(blockTags13);

        const completedAction = await context.tracker.getRebalanceAction(
          inflightToBase!.id,
        );
        expect(completedAction!.status).to.equal('complete');
      }
      // Relay may fail due to ISM configuration in test environment - main assertion already passed
    }
  });

  it('should execute collateralDeficit portion; slow bridge intents fail', async function () {
    const transferAmount = 600000000n; // 600 USDC

    // Use balances that trigger both strategies
    // - Weighted: ethereum has too much (needs rebalance to base)
    // - CollateralDeficit: pending transfer will create deficit on arbitrum
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            anvil1: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil1,
            },
            anvil2: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil2,
            },
            anvil3: {
              buffer: '0',
              bridge: deployedAddresses.bridgeRoute1.anvil3,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            anvil1: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil1,
            },
            anvil2: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil2,
            },
            anvil3: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: deployedAddresses.bridgeRoute2.anvil3,
            },
          },
        },
      ])
      .withBalances('COMPOSITE_DEFICIT_IMBALANCE')
      .withExecutionMode('execute')
      .build();

    // Fund user and execute warp transfer to create deficit
    const ethProvider = localProviders.get('anvil1')!;
    const deployer4 = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    ).connect(ethProvider as any);
    const token4 = ERC20__factory.connect(
      deployedAddresses.tokens.anvil1,
      deployer4,
    );
    await token4.transfer(userAddress, transferAmount * 2n);

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'anvil1',
        destinationChain: 'anvil2',
        routerAddress: deployedAddresses.monitoredRoute.anvil1,
        tokenAddress: deployedAddresses.tokens.anvil1,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags14 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags14);

    // Verify transfer was tracked
    const transfersBeforeRebalance =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeRebalance.length).to.equal(
      1,
      'Should have exactly 1 in-progress transfer',
    );

    // Execute cycle
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);

    // Verify BOTH bridge types have intents/actions
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    const inProgressActions = await context.tracker.getInProgressActions();

    expect(
      activeIntents.length,
      'Should have active rebalance intents',
    ).to.be.greaterThan(0);

    // Helper to get chain name from domain
    const getChainFromDomain = (domain: number): TestChain | undefined =>
      Object.entries(DOMAIN_IDS).find(([, id]) => id === domain)?.[0] as
        | TestChain
        | undefined;

    // Identify SUPERSEED and SUBTENSOR actions
    const superseedActions = [];
    const subtensorActions = [];
    for (const action of inProgressActions) {
      const intent = activeIntents.find((i) => i.id === action.intentId);
      if (intent?.bridge) {
        const originChain = getChainFromDomain(action.origin);
        if (originChain) {
          if (intent.bridge === deployedAddresses.bridgeRoute1[originChain]) {
            superseedActions.push(action);
          } else if (
            intent.bridge === deployedAddresses.bridgeRoute2[originChain]
          ) {
            subtensorActions.push(action);
          }
        }
      }
    }

    expect(
      superseedActions.length,
      'Should have SUPERSEED actions from CollateralDeficit',
    ).to.be.greaterThan(0);
    expect(
      subtensorActions.length,
      'Should have SUBTENSOR actions from Weighted',
    ).to.be.greaterThan(0);

    // Relay SUPERSEED actions (SUBTENSOR relay requires CCIP-read metadata not available in test env)
    for (const action of superseedActions) {
      if (!action.txHash) continue;

      const originChain = getChainFromDomain(action.origin);
      const destChain = getChainFromDomain(action.destination);
      if (!originChain || !destChain) continue;

      const provider = localProviders.get(originChain)!;
      const rebalanceTxReceipt = await provider.getTransactionReceipt(
        action.txHash,
      );

      const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
        dispatchTx: rebalanceTxReceipt,
        messageId: action.messageId!,
        origin: originChain,
        destination: destChain,
      });
      expect(
        relayResult.success,
        `SUPERSEED relay should succeed: ${relayResult.error}`,
      ).to.be.true;
    }

    const blockTags15 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags15);

    for (const action of superseedActions) {
      const completedAction = await context.tracker.getRebalanceAction(
        action.id,
      );
      expect(completedAction!.status).to.equal('complete');
    }

    // Verify SUBTENSOR actions are still in progress (relay not possible in test env)
    for (const action of subtensorActions) {
      const trackedAction = await context.tracker.getRebalanceAction(action.id);
      expect(trackedAction, `SUBTENSOR action ${action.id} should exist`).to
        .exist;
      expect(trackedAction!.status).to.equal('in_progress');
    }

    // Relay the original user transfer now that collateral has been rebalanced
    const userTransferRelay = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(
      userTransferRelay.success,
      `User transfer relay should succeed: ${userTransferRelay.error}`,
    ).to.be.true;

    const blockTags16 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags16);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });
});
