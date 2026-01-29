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

    expect(cycleResult1.proposedRoutes.length).to.be.greaterThan(0);

    const routeToArbitrum = cycleResult1.proposedRoutes.find(
      (r) => r.destination === 'arbitrum',
    );
    expect(routeToArbitrum).to.exist;

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

    const balancesAfterRebalance = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    logger.info(
      {
        balances: Object.fromEntries(
          Object.entries(balancesAfterRebalance).map(([k, v]) => [
            k,
            v.toString(),
          ]),
        ),
      },
      'Collateral balances after rebalance execution',
    );

    context.mockExplorer.updateTransfer(transferResult.messageId, {
      is_delivered: true,
    });

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
