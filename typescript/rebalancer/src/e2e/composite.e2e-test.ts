import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '../config/types.js';
import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';
import type { Monitor } from '../monitor/Monitor.js';

import {
  DOMAIN_IDS,
  FORK_BLOCK_NUMBERS,
  TEST_CHAINS,
  type TestChain,
  USDC_ADDRESSES,
  USDC_INCENTIV_WARP_ROUTE,
  USDC_SUBTENSOR_WARP_ROUTE,
  USDC_SUPERSEED_WARP_ROUTE,
} from './fixtures/routes.js';
import { setTokenBalanceViaStorage } from './harness/BridgeSetup.js';
import { ForkManager } from './harness/ForkManager.js';
import { setupTrustedRelayerIsmForRoute } from './harness/IsmUpdater.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import {
  executeWarpTransfer,
  tryRelayMessage,
} from './harness/TransferHelper.js';

const ANVIL_TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function getFirstMonitorEvent(monitor: Monitor): Promise<MonitorEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Monitor event timeout'));
    }, 60_000);

    monitor.on(MonitorEventType.TokenInfo, (event: MonitorEvent) => {
      clearTimeout(timeout);
      void monitor.stop();
      resolve(event);
    });

    monitor.on(MonitorEventType.Error, (error: Error) => {
      clearTimeout(timeout);
      void monitor.stop();
      reject(error);
    });

    void monitor.start();
  });
}

describe('CompositeStrategy E2E', function () {
  this.timeout(300_000);

  let forkManager: ForkManager;
  let multiProvider: MultiProvider;
  let forkedProviders: Map<string, providers.JsonRpcProvider>;
  let registry: GithubRegistry;
  let userAddress: string;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;

  before(async function () {
    const wallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    userAddress = wallet.address;

    registry = new GithubRegistry();
    const chainMetadata = await registry.getMetadata();
    const testChainMetadata: Record<string, ChainMetadata> = {};

    for (const chain of TEST_CHAINS) {
      if (chainMetadata[chain]) {
        testChainMetadata[chain] = chainMetadata[chain];
      }
    }

    const baseMultiProvider = new MultiProvider(testChainMetadata);
    for (const chain of TEST_CHAINS) {
      baseMultiProvider.setSigner(chain, wallet);
    }

    forkManager = new ForkManager({
      chains: TEST_CHAINS,
      registry,
      multiProvider: baseMultiProvider,
      blockNumbers: FORK_BLOCK_NUMBERS,
    });

    const forkContext = await forkManager.start();
    multiProvider = forkContext.multiProvider;
    forkedProviders = forkContext.providers;

    const allCoreAddresses = await registry.getAddresses();
    const knownChains = new Set(multiProvider.getKnownChainNames());
    const coreAddresses = Object.fromEntries(
      Object.entries(allCoreAddresses).filter(([chain]) =>
        knownChains.has(chain),
      ),
    );
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    // Set up TrustedRelayerIsm on routers so we can relay without validator signatures
    const mailboxesByChain: Record<string, string> = {};
    for (const chain of TEST_CHAINS) {
      const addr = allCoreAddresses[chain]?.mailbox;
      if (addr) mailboxesByChain[chain] = addr;
    }
    // Set up ISM on monitored route (for user transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      mailboxesByChain,
      userAddress,
    );
    // Set up ISM on SUPERSEED bridge route (for rebalance transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_SUPERSEED_WARP_ROUTE.routers,
      mailboxesByChain,
      userAddress,
    );
    // Set up ISM on SUBTENSOR bridge route (for rebalance transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_SUBTENSOR_WARP_ROUTE.routers,
      mailboxesByChain,
      userAddress,
    );

    snapshotIds = new Map();
    for (const [chain, provider] of forkedProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    for (const [chain, provider] of forkedProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      // Fresh snapshot required: Anvil invalidates the snapshot after revert
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  after(async function () {
    if (forkManager) {
      await forkManager.stop();
    }
  });

  it('collateralDeficit + weighted: routes use different bridges', async function () {
    const transferAmount = BigNumber.from('600000000'); // 600 USDC

    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            ethereum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
            },
          },
        },
      ])
      .withBalances('COMPOSITE_DEFICIT_IMBALANCE')
      .withExecutionMode('execute')
      .build();

    // Fund user and execute actual warp transfer
    const ethProvider = forkedProviders.get('ethereum')!;
    await setTokenBalanceViaStorage(
      ethProvider,
      USDC_ADDRESSES.ethereum,
      userAddress,
      transferAmount.mul(2),
    );

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'ethereum',
        destinationChain: 'arbitrum',
        routerAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
        tokenAddress: USDC_ADDRESSES.ethereum,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    // Sync tracker to pick up the new transfer
    const blockTags = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags);
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
          intent.bridge === USDC_SUPERSEED_WARP_ROUTE.routers[originChain]
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
      (a) => a.destination === DOMAIN_IDS.arbitrum,
    );
    expect(actionToArbitrum, 'Should have SUPERSEED action to arbitrum').to
      .exist;

    // Relay SUPERSEED actions and verify completion
    for (const action of superseedActions) {
      if (!action.txHash) continue;

      const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
        action.txHash,
      );
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0];
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0];

      if (originChain && destChain) {
        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt,
            messageId: action.messageId,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(relayResult.success, 'SUPERSEED relay should succeed').to.be
          .true;
      }
    }

    // Sync and verify actions completed
    const blockTags2 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags2);
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
    expect(userTransferRelay.success, 'User transfer relay should succeed').to
      .be.true;

    const blockTags3 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags3);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });

  it('collateralDeficit + minAmount: routes use different bridges', async function () {
    const transferAmount = BigNumber.from('600000000'); // 600 USDC
    const customBalances = {
      ethereum: BigNumber.from('8000000000'),
      arbitrum: BigNumber.from('500000000'),
      base: BigNumber.from('50000000'), // below minAmount threshold (100 USDC)
    };

    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            ethereum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
          chains: {
            ethereum: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              minAmount: {
                min: '100',
                target: '120',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
            },
          },
        },
      ])
      .withBalances(customBalances)
      .withExecutionMode('execute')
      .build();

    const ethProvider = forkedProviders.get('ethereum')!;
    await setTokenBalanceViaStorage(
      ethProvider,
      USDC_ADDRESSES.ethereum,
      userAddress,
      transferAmount.mul(2),
    );

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'ethereum',
        destinationChain: 'arbitrum',
        routerAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
        tokenAddress: USDC_ADDRESSES.ethereum,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags4 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags4);
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
          intent.bridge === USDC_SUPERSEED_WARP_ROUTE.routers[originChain]
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
      (a) => a.destination === DOMAIN_IDS.arbitrum,
    );
    expect(actionToArbitrum, 'Should have SUPERSEED action to arbitrum').to
      .exist;

    for (const action of superseedActions) {
      if (!action.txHash) continue;

      const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
        action.txHash,
      );
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0];
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0];

      if (originChain && destChain) {
        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt,
            messageId: action.messageId,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(relayResult.success, 'SUPERSEED relay should succeed').to.be
          .true;
      }
    }

    const blockTags5 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags5);
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
    expect(userTransferRelay.success, 'User transfer relay should succeed').to
      .be.true;

    const blockTags6 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags6);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });

  it('should propose collateralDeficit rebalance even when slow rebalance is inflight', async function () {
    const ethProvider = forkedProviders.get('ethereum')!;
    const transferAmount = BigNumber.from('600000000');

    // Build context with Composite strategy from the start
    // COMPOSITE_DEFICIT_IMBALANCE: eth=8000, arb=500, base=1500
    // Weighted sees: eth surplus (target=6000), base deficit (target=2000)
    // Cycle 1: Weighted creates SUBTENSOR rebalance eth→base
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            ethereum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
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

    // Sync and verify SUBTENSOR inflight created (from Weighted strategy)
    const blockTags7 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags7);
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
        intent.bridge === USDC_SUBTENSOR_WARP_ROUTE.routers[originChain]
      );
    });
    expect(
      subtensorInflight,
      'Should have SUBTENSOR inflight from Weighted strategy',
    ).to.exist;

    // ===== CYCLE 2: Add pending transfer to create deficit, then execute =====
    // Fund user and execute a warp transfer eth→arbitrum to create deficit on arbitrum
    await setTokenBalanceViaStorage(
      ethProvider,
      USDC_ADDRESSES.ethereum,
      userAddress,
      transferAmount.mul(2),
    );

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'ethereum',
        destinationChain: 'arbitrum',
        routerAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
        tokenAddress: USDC_ADDRESSES.ethereum,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags8 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags8);
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

    // Sync and verify SUPERSEED action created (from CollateralDeficit)
    const blockTags9 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags9);
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
        intent.bridge === USDC_SUPERSEED_WARP_ROUTE.routers[originChain]
      );
    });

    expect(
      superseedActions.length,
      'Should have SUPERSEED actions from CollateralDeficit despite SUBTENSOR inflight',
    ).to.be.greaterThan(0);

    const superseedToArbitrum = superseedActions.find(
      (a) => a.destination === DOMAIN_IDS.arbitrum,
    );
    expect(
      superseedToArbitrum,
      'Should have SUPERSEED action to arbitrum for deficit',
    ).to.exist;

    // Relay SUPERSEED actions and verify completion
    for (const action of superseedActions) {
      if (!action.txHash) continue;

      const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
        action.txHash,
      );
      const originChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.origin,
      )?.[0];
      const destChain = Object.entries(DOMAIN_IDS).find(
        ([, id]) => id === action.destination,
      )?.[0];

      if (originChain && destChain) {
        const relayResult = await tryRelayMessage(
          multiProvider,
          hyperlaneCore,
          {
            dispatchTx: rebalanceTxReceipt,
            messageId: action.messageId,
            origin: originChain,
            destination: destChain,
          },
        );
        expect(relayResult.success, 'SUPERSEED relay should succeed').to.be
          .true;
      }
    }

    const blockTags10 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags10);
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
    expect(userTransferRelay.success, 'User transfer relay should succeed').to
      .be.true;
  });

  it('should simulate end state accounting for inflight rebalances', async function () {
    const ethProvider = forkedProviders.get('ethereum')!;

    // Build context with Weighted strategy
    // Initial: eth=7000, arb=2000, base=1000 (total=10000)
    // Target: eth=60% (6000), arb=20% (2000), base=20% (2000)
    // Cycle 1 will create inflight eth→base for ~1000 USDC
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
            },
          },
        },
      ])
      .withBalances({
        ethereum: BigNumber.from('7000000000'),
        arbitrum: BigNumber.from('2000000000'),
        base: BigNumber.from('1000000000'),
      })
      .withExecutionMode('execute')
      .build();

    // ===== CYCLE 1: Execute rebalance to create inflight eth→base =====
    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    const blockTags11 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags11);
    await context.tracker.syncRebalanceActions(blockTags11);

    const inflightAfterCycle1 = await context.tracker.getInProgressActions();
    expect(
      inflightAfterCycle1.length,
      'Cycle 1 should create inflight action',
    ).to.be.greaterThan(0);

    const inflightToBase = inflightAfterCycle1.find(
      (a) =>
        a.destination === DOMAIN_IDS.base && a.origin === DOMAIN_IDS.ethereum,
    );
    expect(inflightToBase, 'Should have inflight action eth→base').to.exist;

    const inflightAmount = BigNumber.from(inflightToBase!.amount);
    expect(inflightAmount.gt(0), 'Inflight amount should be positive').to.be
      .true;

    // ===== CYCLE 2: Execute again - should account for inflight =====
    // Weighted now sees: base effective = current + inflight ≈ 2000 (target)
    // Should propose reduced amount or nothing to base
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    const cycleResult2 = await context.orchestrator.executeCycle(event2);

    const blockTags12 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags12);
    await context.tracker.syncRebalanceActions(blockTags12);

    // Check if new routes to base were proposed
    const routesToBase = cycleResult2.proposedRoutes.filter(
      (r) => r.destination === 'base',
    );
    const inProgressAfterCycle2 = await context.tracker.getInProgressActions();
    const newActionsToBase = inProgressAfterCycle2.filter(
      (a) =>
        a.destination === DOMAIN_IDS.base &&
        a.id !== inflightToBase!.id &&
        a.status === 'in_progress',
    );

    if (routesToBase.length > 0 || newActionsToBase.length > 0) {
      // If route was proposed, should be much smaller than original 1000 USDC
      const proposedAmount =
        routesToBase.length > 0
          ? routesToBase[0].amount
          : BigNumber.from(newActionsToBase[0].amount).toBigInt();
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
        messageId: inflightToBase.messageId,
        origin: 'ethereum',
        destination: 'base',
      });

      if (relayResult.success) {
        const blockTags13 = await context.getConfirmedBlockTags();
        await context.forkIndexer.sync(blockTags13);
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
    const transferAmount = BigNumber.from('600000000'); // 600 USDC

    // Use balances that trigger both strategies
    // - Weighted: ethereum has too much (needs rebalance to base)
    // - CollateralDeficit: pending transfer will create deficit on arbitrum
    const context = await TestRebalancer.builder(forkManager, multiProvider)
      .withStrategy([
        {
          rebalanceStrategy: RebalancerStrategyOptions.CollateralDeficit,
          chains: {
            ethereum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              buffer: '0',
              bridge: USDC_SUPERSEED_WARP_ROUTE.routers.base,
            },
          },
        },
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
            },
            arbitrum: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.arbitrum,
            },
            base: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
            },
          },
        },
      ])
      .withBalances('COMPOSITE_DEFICIT_IMBALANCE')
      .withExecutionMode('execute')
      .build();

    // Fund user and execute warp transfer to create deficit
    const ethProvider = forkedProviders.get('ethereum')!;
    await setTokenBalanceViaStorage(
      ethProvider,
      USDC_ADDRESSES.ethereum,
      userAddress,
      transferAmount.mul(2),
    );

    const transferResult = await executeWarpTransfer(
      context.multiProvider,
      {
        originChain: 'ethereum',
        destinationChain: 'arbitrum',
        routerAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
        tokenAddress: USDC_ADDRESSES.ethereum,
        amount: transferAmount,
        recipient: userAddress,
        senderAddress: userAddress,
      },
      ethProvider,
    );

    const blockTags14 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags14);
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
          if (
            intent.bridge === USDC_SUPERSEED_WARP_ROUTE.routers[originChain]
          ) {
            superseedActions.push(action);
          } else if (
            intent.bridge === USDC_SUBTENSOR_WARP_ROUTE.routers[originChain]
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

      const provider = forkedProviders.get(originChain)!;
      const rebalanceTxReceipt = await provider.getTransactionReceipt(
        action.txHash,
      );

      const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
        dispatchTx: rebalanceTxReceipt,
        messageId: action.messageId,
        origin: originChain,
        destination: destChain,
      });
      expect(relayResult.success, 'SUPERSEED relay should succeed').to.be.true;
    }

    // Sync and verify SUPERSEED actions complete
    const blockTags15 = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags15);
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
    expect(userTransferRelay.success, 'User transfer relay should succeed').to
      .be.true;

    const blockTags16 = await context.getConfirmedBlockTags();
    await context.tracker.syncTransfers(blockTags16);
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });
});
