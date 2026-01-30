import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';
import { pino } from 'pino';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, toWei } from '@hyperlane-xyz/utils';

import { RebalancerStrategyOptions } from '../config/types.js';
import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';
import type { Monitor } from '../monitor/Monitor.js';

import {
  DOMAIN_IDS,
  TEST_CHAINS,
  USDC_ADDRESSES,
  USDC_INCENTIV_WARP_ROUTE,
  USDC_SUPERSEED_WARP_ROUTE,
} from './fixtures/routes.js';
import {
  getAllCollateralBalances,
  setTokenBalanceViaStorage,
} from './harness/BridgeSetup.js';
import { ForkManager } from './harness/ForkManager.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import {
  type WarpTransferResult,
  executeWarpTransfer,
  tryRelayMessage,
} from './harness/TransferHelper.js';

const USDC_DECIMALS = 6;
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

function encodeWarpRouteMessageBody(
  recipient: string,
  amount: BigNumber,
): string {
  const recipientBytes32 = addressToBytes32(recipient);
  const amountHex = ethers.utils.hexZeroPad(amount.toHexString(), 32);
  return recipientBytes32 + amountHex.slice(2);
}

describe('Collateral Deficit E2E', function () {
  this.timeout(300_000);

  let forkManager: ForkManager;
  let multiProvider: MultiProvider;
  let forkedProviders: Map<string, providers.JsonRpcProvider>;
  let registry: GithubRegistry;
  let relayerAddress: string;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;

  const logger = pino({ level: 'debug' });

  before(async function () {
    const wallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    relayerAddress = wallet.address;

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

  it('should propose rebalance route when pending transfer creates collateral deficit', async function () {
    const transferAmount = BigNumber.from(toWei('500', USDC_DECIMALS));

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
      ])
      .withBalances('DEFICIT_ARB')
      .withPendingTransfer({
        from: 'ethereum',
        to: 'arbitrum',
        amount: transferAmount,
        warpRecipient: relayerAddress,
      })
      .withExecutionMode('propose')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    const cycleResult = await context.orchestrator.executeCycle(event);

    expect(cycleResult.proposedRoutes.length).to.be.greaterThan(0);

    const routeToArbitrum = cycleResult.proposedRoutes.find(
      (r) => r.destination === 'arbitrum',
    );
    expect(routeToArbitrum).to.exist;
    expect(routeToArbitrum!.amount > 0n).to.be.true;

    logger.info(
      {
        routeToArbitrum: {
          origin: routeToArbitrum!.origin,
          destination: routeToArbitrum!.destination,
          amount: routeToArbitrum!.amount.toString(),
        },
      },
      'Found proposed route to arbitrum (deficit chain)',
    );
  });

  it('should execute full rebalance cycle with actual transfers', async function () {
    const transferAmount = BigNumber.from(toWei('500', USDC_DECIMALS));

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
      ])
      .withBalances('DEFICIT_ARB')
      .withExecutionMode('execute')
      .build();

    // Capture initial collateral balances before any operations
    const initialCollateralBalances = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    logger.info(
      {
        balances: Object.fromEntries(
          Object.entries(initialCollateralBalances).map(([k, v]) => [
            k,
            v.toString(),
          ]),
        ),
      },
      'Initial collateral balances',
    );

    // TODO: this should move into setup, we can set the test account balance to a million
    const ethProvider = forkedProviders.get('ethereum')!;
    await setTokenBalanceViaStorage(
      ethProvider,
      USDC_ADDRESSES.ethereum,
      relayerAddress,
      transferAmount.mul(2),
    );

    logger.info('Funded test wallet with USDC');

    let transferResult: WarpTransferResult;
    try {
      transferResult = await executeWarpTransfer(
        context.multiProvider,
        {
          originChain: 'ethereum',
          destinationChain: 'arbitrum',
          routerAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
          tokenAddress: USDC_ADDRESSES.ethereum,
          amount: transferAmount,
          recipient: relayerAddress,
          senderAddress: relayerAddress,
        },
        ethProvider,
      );
      logger.info(
        { messageId: transferResult.messageId },
        'Sent actual warp transfer ETH→ARB',
      );
    } catch (error) {
      logger.error({ error }, 'Failed to send warp transfer');
      throw error;
    }

    // Get collateral balances after user transfer dispatch
    const balancesAfterUserTransfer = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    // Assert: Origin collateral INCREASED (user deposited tokens into router)
    expect(
      balancesAfterUserTransfer.ethereum.gt(initialCollateralBalances.ethereum),
      `Origin (ethereum) collateral should increase after user deposit. ` +
        `Before: ${initialCollateralBalances.ethereum.toString()}, After: ${balancesAfterUserTransfer.ethereum.toString()}`,
    ).to.be.true;

    // TODO: this assertion should move after the relayAttempt1
    // Assert: Destination collateral UNCHANGED (transfer not delivered yet)
    expect(
      balancesAfterUserTransfer.arbitrum.eq(initialCollateralBalances.arbitrum),
      `Destination (arbitrum) collateral should be unchanged before delivery. ` +
        `Before: ${initialCollateralBalances.arbitrum.toString()}, After: ${balancesAfterUserTransfer.arbitrum.toString()}`,
    ).to.be.true;

    logger.info(
      {
        ethereum: {
          before: initialCollateralBalances.ethereum.toString(),
          after: balancesAfterUserTransfer.ethereum.toString(),
          change: balancesAfterUserTransfer.ethereum
            .sub(initialCollateralBalances.ethereum)
            .toString(),
        },
        arbitrum: {
          before: initialCollateralBalances.arbitrum.toString(),
          after: balancesAfterUserTransfer.arbitrum.toString(),
          change: '0 (unchanged)',
        },
      },
      'Collateral balances after user transfer dispatch',
    );

    const relayAttempt1 = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );

    logger.info(
      {
        success: relayAttempt1.success,
        error: relayAttempt1.error?.substring(0, 200),
      },
      'First relay attempt (should fail - insufficient collateral)',
    );

    expect(relayAttempt1.success).to.be.false;

    context.mockExplorer.addUserTransfer({
      msg_id: transferResult.messageId,
      origin_domain_id: DOMAIN_IDS.ethereum,
      destination_domain_id: DOMAIN_IDS.arbitrum,
      sender: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      recipient: USDC_INCENTIV_WARP_ROUTE.routers.arbitrum,
      origin_tx_hash: transferResult.dispatchTx.transactionHash,
      origin_tx_sender: relayerAddress,
      origin_tx_recipient: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      is_delivered: false,
      message_body: encodeWarpRouteMessageBody(relayerAddress, transferAmount),
    });

    logger.info('Added pending transfer to MockExplorer');

    // Sync action tracker to pick up the new transfer
    await context.tracker.syncTransfers();

    // Assert: User transfer exists in action tracker
    const transfersBeforeRebalance =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeRebalance.length).to.equal(
      1,
      'Should have exactly 1 in-progress transfer',
    );
    expect(transfersBeforeRebalance[0].messageId).to.equal(
      transferResult.messageId,
    );
    expect(transfersBeforeRebalance[0].destination).to.equal(
      DOMAIN_IDS.arbitrum,
      'Transfer destination should be arbitrum',
    );
    // TODO assert the transfer origin and amount also

    logger.info(
      {
        transferId: transfersBeforeRebalance[0].id,
        messageId: transfersBeforeRebalance[0].messageId,
        origin: transfersBeforeRebalance[0].origin,
        destination: transfersBeforeRebalance[0].destination,
        amount: transfersBeforeRebalance[0].amount.toString(),
        status: transfersBeforeRebalance[0].status,
      },
      'User transfer tracked in ActionTracker',
    );

    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    const cycleResult1 = await context.orchestrator.executeCycle(event1);

    logger.info(
      {
        proposedRoutes: cycleResult1.proposedRoutes.length,
        executedCount: cycleResult1.executedCount,
        failedCount: cycleResult1.failedCount,
      },
      'First cycle result',
    );

    // TODO: dont directly assert on cycleResult1, rely on action tracker state
    // Assert: Routes were proposed to cover the deficit
    expect(cycleResult1.proposedRoutes.length).to.be.greaterThan(0);

    const routeToArbitrum = cycleResult1.proposedRoutes.find(
      (r) => r.destination === 'arbitrum',
    );
    expect(routeToArbitrum).to.exist;
    expect(routeToArbitrum!.amount > 0n).to.be.true;

    logger.info(
      {
        route: {
          origin: routeToArbitrum!.origin,
          destination: routeToArbitrum!.destination,
          amount: routeToArbitrum!.amount.toString(),
        },
      },
      'Proposed rebalance route',
    );

    // Assert: Rebalance was executed (not just proposed)
    expect(
      cycleResult1.executedCount,
      'executedCount should be > 0 when Rebalancer is configured',
    ).to.be.greaterThan(0);
    expect(
      cycleResult1.failedCount,
      'failedCount should be 0 for successful rebalance',
    ).to.equal(0);

    // Assert: Rebalance intent was created and is in_progress
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Should have at least 1 active rebalance intent',
    ).to.be.greaterThan(0);

    const intentToArbitrum = activeIntents.find(
      (i) => i.destination === DOMAIN_IDS.arbitrum,
    );
    expect(intentToArbitrum, 'Should have intent destined for arbitrum').to
      .exist;
    expect(
      intentToArbitrum!.status,
      'Intent status should be in_progress after action creation',
    ).to.equal('in_progress');
    expect(intentToArbitrum!.amount > 0n, 'Intent amount should be positive').to
      .be.true;

    logger.info(
      {
        intentId: intentToArbitrum!.id,
        origin: intentToArbitrum!.origin,
        destination: intentToArbitrum!.destination,
        amount: intentToArbitrum!.amount.toString(),
        status: intentToArbitrum!.status,
        fulfilledAmount: intentToArbitrum!.fulfilledAmount.toString(),
      },
      'Rebalance intent created',
    );

    // Assert: Monitored route collateral on origin DECREASED (sent to bridge)
    const balancesAfterRebalance = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    expect(
      balancesAfterRebalance.ethereum.lt(balancesAfterUserTransfer.ethereum),
      `INCENTIV ethereum collateral should decrease after rebalance. ` +
        `Before: ${balancesAfterUserTransfer.ethereum.toString()}, After: ${balancesAfterRebalance.ethereum.toString()}`,
    ).to.be.true;

    logger.info(
      {
        ethereum: {
          beforeRebalance: balancesAfterUserTransfer.ethereum.toString(),
          afterRebalance: balancesAfterRebalance.ethereum.toString(),
          change: balancesAfterRebalance.ethereum
            .sub(balancesAfterUserTransfer.ethereum)
            .toString(),
        },
      },
      'INCENTIV collateral balances after rebalance',
    );

    // Mark transfer as delivered in mock explorer
    context.mockExplorer.updateTransfer(transferResult.messageId, {
      is_delivered: true,
    });

    // Run second cycle to verify behavior with delivered transfer
    const monitor2 = context.createMonitor(0);
    const event2 = await getFirstMonitorEvent(monitor2);
    const cycleResult2 = await context.orchestrator.executeCycle(event2);

    logger.info(
      {
        proposedRoutes: cycleResult2.proposedRoutes.length,
        executedCount: cycleResult2.executedCount,
      },
      'Second cycle result (should have no new routes)',
    );

    const newRoutesToArbitrum = cycleResult2.proposedRoutes.filter(
      (r) => r.destination === 'arbitrum',
    );

    logger.info(
      { newRoutesToArbitrum: newRoutesToArbitrum.length },
      'New routes to arbitrum in second cycle',
    );
  });
});
