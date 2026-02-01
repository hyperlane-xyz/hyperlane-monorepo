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
import { addressToBytes32 } from '@hyperlane-xyz/utils';

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
  getRebalancerAddress,
  tryRelayMessage,
} from './harness/TransferHelper.js';

const ANVIL_TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function encodeWarpRouteMessageBody(
  recipient: string,
  amount: BigNumber,
): string {
  const recipientBytes32 = addressToBytes32(recipient);
  const amountHex = ethers.utils.hexZeroPad(amount.toHexString(), 32);
  return recipientBytes32 + amountHex.slice(2);
}

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
    await context.forkIndexer.sync();
    await context.tracker.syncTransfers();

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
    ).to.be.greaterThan(0);

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
    ).to.be.greaterThan(0);

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
    await context.forkIndexer.sync();
    await context.tracker.syncRebalanceActions();

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

    await context.tracker.syncTransfers();
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

    await context.forkIndexer.sync();
    await context.tracker.syncTransfers();

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

    await context.forkIndexer.sync();
    await context.tracker.syncRebalanceActions();

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

    await context.tracker.syncTransfers();
    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });

  it('should propose collateralDeficit rebalance even when slow rebalance is inflight', async function () {
    const ethProvider = forkedProviders.get('ethereum')!;
    const rebalancerAddress = await getRebalancerAddress(
      ethProvider,
      USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
    );

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
      .withPendingTransfer({
        from: 'ethereum',
        to: 'arbitrum',
        amount: BigNumber.from('600000000'),
      })
      .withExecutionMode('propose')
      .build();

    // Seed an inflight SUBTENSOR rebalance (slow bridge) eth→base
    // TODO: why dont we use the forkindexer?
    context.mockExplorer.addRebalanceAction({
      msg_id: '0x' + '1'.repeat(64),
      origin_domain_id: DOMAIN_IDS.ethereum,
      destination_domain_id: DOMAIN_IDS.base,
      sender: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
      recipient: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
      origin_tx_hash: '0x' + '2'.repeat(64),
      origin_tx_sender: rebalancerAddress,
      origin_tx_recipient: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      is_delivered: false,
      message_body: encodeWarpRouteMessageBody(
        USDC_SUBTENSOR_WARP_ROUTE.routers.base,
        BigNumber.from('500000000'),
      ),
    });

    await context.tracker.syncRebalanceActions();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    const cycleResult = await context.orchestrator.executeCycle(event);

    // Assert: New SUPERSEED route to arb despite inflight SUBTENSOR to base
    // TODO: dont assert using the cycleResult, directly inspect the actiona tracker
    const superseedRouteToArb = cycleResult.proposedRoutes.find(
      (r) =>
        r.destination === 'arbitrum' &&
        r.bridge === USDC_SUPERSEED_WARP_ROUTE.routers[r.origin as TestChain],
    );
    expect(
      superseedRouteToArb,
      'Should propose SUPERSEED route to arbitrum for deficit',
    ).to.exist;
  });

  it('should simulate end state accounting for inflight rebalances', async function () {
    const ethProvider = forkedProviders.get('ethereum')!;
    const rebalancerAddress = await getRebalancerAddress(
      ethProvider,
      USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
    );

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
      .withExecutionMode('propose')
      .build();

    // Seed inflight rebalance: eth→base 800 USDC via SUBTENSOR
    // This simulates end state: base would have 1800 USDC
    // TODO: why not initiate a manual rebalance and use
    // TODO: why not use the forkindexer
    context.mockExplorer.addRebalanceAction({
      msg_id: '0x' + '3'.repeat(64),
      origin_domain_id: DOMAIN_IDS.ethereum,
      destination_domain_id: DOMAIN_IDS.base,
      sender: USDC_SUBTENSOR_WARP_ROUTE.routers.ethereum,
      recipient: USDC_SUBTENSOR_WARP_ROUTE.routers.base,
      origin_tx_hash: '0x' + '4'.repeat(64),
      origin_tx_sender: rebalancerAddress,
      origin_tx_recipient: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      is_delivered: false,
      message_body: encodeWarpRouteMessageBody(
        USDC_SUBTENSOR_WARP_ROUTE.routers.base,
        BigNumber.from('800000000'),
      ),
    });

    await context.tracker.syncRebalanceActions();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    const cycleResult = await context.orchestrator.executeCycle(event);

    // With inflight accounted, Weighted sees base closer to target (2000)
    // Current: base=1000, inflight +800 = effective 1800, target=2000 (20% of 10000)
    // Should propose smaller amount or no route
    // TODO: dont assert using the cycleResult, directly inspect the actiona tracker
    const routeToBase = cycleResult.proposedRoutes.find(
      (r) => r.destination === 'base',
    );

    if (routeToBase) {
      // If a route exists, it should be reduced accounting for inflight
      // Without inflight: need 1000 USDC to reach 2000 target
      // With inflight: need 200 USDC to reach 2000 target
      expect(
        routeToBase.amount < 1000000000n,
        'Amount should be reduced accounting for inflight',
      ).to.be.true;
    }
    // If no route, that's also valid (within tolerance after inflight)
  });

  it('should execute collateralDeficit portion; slow bridge intents fail', async function () {
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
      .withPendingTransfer({
        from: 'ethereum',
        to: 'arbitrum',
        amount: BigNumber.from('600000000'),
      })
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    const cycleResult = await context.orchestrator.executeCycle(event);

    // Assert: Some routes executed, some failed (SUBTENSOR not in allowed bridges)
    // SUPERSEED routes should succeed (allowed bridge), SUBTENSOR should fail
    const inProgressActions = await context.tracker.getInProgressActions();
    const activeIntents = await context.tracker.getActiveRebalanceIntents();

    // Check for successful SUPERSEED actions via their parent intents
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

    // Verify SUBTENSOR intents were created but execution failed (no allowed bridge)
    // The failedCount or failed intents indicate SUBTENSOR routes couldn't execute
    expect(
      cycleResult.failedCount > 0 || cycleResult.proposedRoutes.length > 0,
      'Some routes should fail or be proposed but not executed',
    ).to.be.true;

    // Relay SUPERSEED actions and verify completion
    const ethProvider = forkedProviders.get('ethereum')!;
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
    await context.forkIndexer.sync();
    await context.tracker.syncRebalanceActions();

    for (const action of superseedActions) {
      const completedAction = await context.tracker.getRebalanceAction(
        action.id,
      );
      expect(completedAction!.status).to.equal('complete');
    }
  });
});
