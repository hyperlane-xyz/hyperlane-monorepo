import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';
import { pino } from 'pino';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import { RebalancerStrategyOptions } from '../config/types.js';
import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';
import type { Monitor } from '../monitor/Monitor.js';

import { TEST_CHAINS, USDC_SUPERSEED_WARP_ROUTE } from './fixtures/routes.js';
import { ForkManager } from './harness/ForkManager.js';
import { TestRebalancer } from './harness/TestRebalancer.js';

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

describe('Collateral Deficit E2E', function () {
  this.timeout(300_000);

  let forkManager: ForkManager;
  let multiProvider: MultiProvider;
  let forkedProviders: Map<string, providers.JsonRpcProvider>;
  let registry: GithubRegistry;
  let relayerAddress: string;
  let snapshotIds: Map<string, string>;

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
});
