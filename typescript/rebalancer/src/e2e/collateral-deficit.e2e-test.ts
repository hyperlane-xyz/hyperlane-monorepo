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
import { toWei } from '@hyperlane-xyz/utils';

import { RebalancerStrategyOptions } from '../config/types.js';
import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';
import type { Monitor } from '../monitor/Monitor.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  DOMAIN_IDS,
  FORK_BLOCK_NUMBERS,
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
import { setupTrustedRelayerIsmForRoute } from './harness/IsmUpdater.js';
import { TestRebalancer } from './harness/TestRebalancer.js';
import {
  executeWarpTransfer,
  tryRelayMessage,
} from './harness/TransferHelper.js';

const USDC_DECIMALS = 6;

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
    // Set up ISM on bridge route (for rebalance transfers)
    await setupTrustedRelayerIsmForRoute(
      multiProvider,
      TEST_CHAINS,
      USDC_SUPERSEED_WARP_ROUTE.routers,
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
        warpRecipient: userAddress,
      })
      .withExecutionMode('execute')
      .build();

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);

    await context.orchestrator.executeCycle(event);

    // Assert: Strategy created rebalance intents for the deficit chain
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.be.greaterThan(0);

    const intentToArbitrum = activeIntents.find(
      (i) => i.destination === DOMAIN_IDS.arbitrum,
    );
    expect(intentToArbitrum, 'Should have intent destined for arbitrum').to
      .exist;
    expect(intentToArbitrum!.amount).to.equal(400000000n);
    expect(intentToArbitrum!.origin).to.equal(DOMAIN_IDS.ethereum);
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

    const initialCollateralBalances = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

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

    // Get collateral balances after user transfer dispatch
    const balancesAfterUserTransfer = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    // Assert: Origin collateral INCREASED by exactly the transfer amount (user deposited tokens into router)
    const expectedCollateralAfterDeposit =
      initialCollateralBalances.ethereum.add(transferAmount);
    expect(
      balancesAfterUserTransfer.ethereum.eq(expectedCollateralAfterDeposit),
      `Origin (ethereum) collateral should increase by transfer amount. ` +
        `Expected: ${expectedCollateralAfterDeposit.toString()}, Actual: ${balancesAfterUserTransfer.ethereum.toString()}`,
    ).to.be.true;

    const userTransferRelay1 = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );

    // Assert: Relay fails due to insufficient collateral on destination
    expect(userTransferRelay1.success).to.be.false;

    // Assert: Destination collateral UNCHANGED (transfer not delivered)
    expect(
      balancesAfterUserTransfer.arbitrum.eq(initialCollateralBalances.arbitrum),
      `Destination (arbitrum) collateral should be unchanged before delivery. ` +
        `Before: ${initialCollateralBalances.arbitrum.toString()}, After: ${balancesAfterUserTransfer.arbitrum.toString()}`,
    ).to.be.true;

    // Index the dispatched message using ForkIndexer
    const blockTags = await context.getConfirmedBlockTags();
    await context.forkIndexer.sync(blockTags);

    // Sync action tracker to pick up the new transfer
    await context.tracker.syncTransfers(blockTags);

    // Assert: User transfer exists in action tracker with correct fields
    const transfersBeforeRebalance =
      await context.tracker.getInProgressTransfers();
    expect(transfersBeforeRebalance.length).to.equal(
      1,
      'Should have exactly 1 in-progress transfer',
    );

    const trackedTransfer = transfersBeforeRebalance[0];
    // Assert all Transfer fields (except createdAt, updatedAt, messageId, txHash)
    expect(trackedTransfer.id).to.be.a('string').and.not.be.empty;
    expect(trackedTransfer.origin).to.equal(
      DOMAIN_IDS.ethereum,
      'Transfer origin should be ethereum',
    );
    expect(trackedTransfer.destination).to.equal(
      DOMAIN_IDS.arbitrum,
      'Transfer destination should be arbitrum',
    );
    expect(trackedTransfer.amount.toString()).to.equal(
      transferAmount.toString(),
      'Transfer amount should match',
    );
    expect(trackedTransfer.status).to.equal(
      'in_progress',
      'Transfer status should be in_progress',
    );
    expect(trackedTransfer.messageId).to.equal(
      transferResult.messageId,
      'Transfer messageId should match dispatched message',
    );
    expect(trackedTransfer.sender.toLowerCase()).to.equal(
      USDC_INCENTIV_WARP_ROUTE.routers.ethereum.toLowerCase(),
      'Transfer sender should be the warp route router',
    );
    expect(trackedTransfer.recipient.toLowerCase()).to.equal(
      USDC_INCENTIV_WARP_ROUTE.routers.arbitrum.toLowerCase(),
      'Transfer recipient should be the destination warp route router',
    );

    const monitor1 = context.createMonitor(0);
    const event1 = await getFirstMonitorEvent(monitor1);
    await context.orchestrator.executeCycle(event1);

    // Assert: Rebalance intent was created with correct fields
    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Should have exactly 1 active rebalance intent',
    ).to.equal(1);

    const intentToArbitrum = activeIntents.find(
      (i) => i.destination === DOMAIN_IDS.arbitrum,
    );
    expect(intentToArbitrum, 'Should have intent destined for arbitrum').to
      .exist;

    // Assert all RebalanceIntent fields (except createdAt, updatedAt)
    expect(intentToArbitrum!.id).to.be.a('string').and.not.be.empty;
    expect(intentToArbitrum!.origin).to.equal(DOMAIN_IDS.ethereum);
    expect(intentToArbitrum!.destination).to.equal(DOMAIN_IDS.arbitrum);
    expect(intentToArbitrum!.amount).to.equal(400000000n);
    expect(intentToArbitrum!.status).to.equal('in_progress');
    expect(intentToArbitrum!.fulfilledAmount).to.equal(0n);

    // Capture intent ID for completion verification
    const rebalanceIntentId = intentToArbitrum!.id;

    // Assert: Rebalance action was created with correct fields
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(
      inProgressActions.length,
      'Should have at least 1 in-progress action',
    ).to.be.greaterThan(0);

    const actionToArbitrum = inProgressActions.find(
      (a) => a.destination === DOMAIN_IDS.arbitrum,
    );
    expect(actionToArbitrum, 'Should have action destined for arbitrum').to
      .exist;

    // Assert all RebalanceAction fields (except createdAt, updatedAt, messageId, txHash)
    expect(actionToArbitrum!.id).to.be.a('string').and.not.be.empty;
    expect(actionToArbitrum!.intentId).to.equal(rebalanceIntentId);
    expect(actionToArbitrum!.origin).to.equal(DOMAIN_IDS.ethereum);
    expect(actionToArbitrum!.destination).to.equal(DOMAIN_IDS.arbitrum);
    expect(actionToArbitrum!.amount).to.equal(400000000n);
    expect(actionToArbitrum!.status).to.equal('in_progress');
    expect(actionToArbitrum!.messageId).to.be.a('string').and.not.be.empty;

    // Assert: Monitored route collateral on origin DECREASED (sent to bridge)
    const balancesAfterRebalance = await getAllCollateralBalances(
      forkedProviders,
      TEST_CHAINS,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
    );

    // Assert exact balance: initial 10000 + user deposit 500 - rebalance 400 = 10100 USDC
    expect(
      balancesAfterRebalance.ethereum.toString(),
      'INCENTIV ethereum collateral should be 10100 USDC after rebalance',
    ).to.equal('10100000000');

    // Verify entities can be retrieved by ID and have correct status
    const retrievedTransfer = await context.tracker.getTransfer(
      trackedTransfer.id,
    );
    expect(retrievedTransfer, 'Transfer should be retrievable by ID').to.exist;
    expect(retrievedTransfer!.id).to.equal(trackedTransfer.id);
    expect(retrievedTransfer!.status).to.equal('in_progress');

    const retrievedIntent =
      await context.tracker.getRebalanceIntent(rebalanceIntentId);
    expect(retrievedIntent, 'Intent should be retrievable by ID').to.exist;
    expect(retrievedIntent!.id).to.equal(rebalanceIntentId);
    expect(retrievedIntent!.status).to.equal('in_progress');

    const retrievedAction = await context.tracker.getRebalanceAction(
      actionToArbitrum!.id,
    );
    expect(retrievedAction, 'Action should be retrievable by ID').to.exist;
    expect(retrievedAction!.id).to.equal(actionToArbitrum!.id);
    expect(retrievedAction!.status).to.equal('in_progress');

    // Relay the rebalance message to destination (use global multiProvider which has signers on all chains)
    expect(actionToArbitrum!.txHash, 'Action should have txHash').to.exist;
    const rebalanceTxReceipt = await ethProvider.getTransactionReceipt(
      actionToArbitrum!.txHash!,
    );
    const rebalanceRelayResult = await tryRelayMessage(
      multiProvider,
      hyperlaneCore,
      {
        dispatchTx: rebalanceTxReceipt,
        messageId: actionToArbitrum!.messageId,
        origin: 'ethereum',
        destination: 'arbitrum',
      },
    );
    expect(rebalanceRelayResult.success, 'Rebalance relay should succeed').to.be
      .true;

    const userTransferRelay2 = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(userTransferRelay2.success, 'User transfer relay should succeed').to
      .be.true;

    // Sync actions to detect delivery and mark complete
    const blockTags2 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags2);
    await context.tracker.syncTransfers(blockTags2);

    // Assert: Action is now complete
    const completedAction = await context.tracker.getRebalanceAction(
      actionToArbitrum!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    // Assert: Intent is now complete (fulfilledAmount >= amount)
    const completedIntent =
      await context.tracker.getRebalanceIntent(rebalanceIntentId);
    expect(completedIntent!.status).to.equal('complete');
    expect(completedIntent!.fulfilledAmount).to.equal(400000000n);

    // Assert: No more in-progress actions
    const remainingActions = await context.tracker.getInProgressActions();
    expect(remainingActions.length).to.equal(0);

    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });
});
