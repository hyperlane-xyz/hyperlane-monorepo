import { expect } from 'chai';

import {
  HyperlaneCore,
  LocalAccountViemSigner,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';
import { ensure0x, toWei } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  ANVIL_USER_PRIVATE_KEY,
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import { getAllCollateralBalances } from './harness/BridgeSetup.js';
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

const USDC_DECIMALS = 6;

describe('Collateral Deficit E2E', function () {
  this.timeout(300_000);

  let deploymentManager: LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, ReturnType<MultiProvider['getProvider']>>;
  let userAddress: string;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;
  let collateralDeficitStrategyConfig: StrategyConfig[];

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

    collateralDeficitStrategyConfig = [
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
    ];

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

  it('should propose rebalance route when pending transfer creates collateral deficit', async function () {
    const transferAmount = BigInt(toWei('500', USDC_DECIMALS));

    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(collateralDeficitStrategyConfig)
      .withBalances('DEFICIT_ARB')
      .withPendingTransfer({
        from: 'anvil1',
        to: 'anvil2',
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
      (i) => i.destination === DOMAIN_IDS.anvil2,
    );
    expect(intentToArbitrum, 'Should have intent destined for arbitrum').to
      .exist;
    expect(intentToArbitrum!.amount).to.equal(400000000n);
    expect(intentToArbitrum!.origin).to.equal(DOMAIN_IDS.anvil1);
  });

  it('should execute full rebalance cycle with actual transfers', async function () {
    const transferAmount = BigInt(toWei('500', USDC_DECIMALS));

    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(collateralDeficitStrategyConfig)
      .withBalances('DEFICIT_ARB')
      .withExecutionMode('execute')
      .build();

    const initialCollateralBalances = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    const ethProvider = localProviders.get('anvil1')!;
    const deployer = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    ).connect(ethProvider as any);
    const token = (await import('@hyperlane-xyz/core')).ERC20__factory.connect(
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

    // Get collateral balances after user transfer dispatch
    const balancesAfterUserTransfer = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    // Assert: Origin collateral INCREASED by exactly the transfer amount (user deposited tokens into router)
    const expectedCollateralAfterDeposit =
      initialCollateralBalances.anvil1 + transferAmount;
    expect(
      balancesAfterUserTransfer.anvil1 === expectedCollateralAfterDeposit,
      `Origin (anvil1) collateral should increase by transfer amount. ` +
        `Expected: ${expectedCollateralAfterDeposit}, Actual: ${balancesAfterUserTransfer.anvil1}`,
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
      balancesAfterUserTransfer.anvil2 === initialCollateralBalances.anvil2,
      `Destination (anvil2) collateral should be unchanged before delivery. ` +
        `Before: ${initialCollateralBalances.anvil2}, After: ${balancesAfterUserTransfer.anvil2}`,
    ).to.be.true;

    const blockTags = await context.getConfirmedBlockTags();
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
      DOMAIN_IDS.anvil1,
      'Transfer origin should be ethereum',
    );
    expect(trackedTransfer.destination).to.equal(
      DOMAIN_IDS.anvil2,
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
      deployedAddresses.monitoredRoute.anvil1.toLowerCase(),
      'Transfer sender should be the warp route router',
    );
    expect(trackedTransfer.recipient.toLowerCase()).to.equal(
      deployedAddresses.monitoredRoute.anvil2.toLowerCase(),
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
      (i) => i.destination === DOMAIN_IDS.anvil2,
    );
    expect(intentToArbitrum, 'Should have intent destined for arbitrum').to
      .exist;

    // Assert all RebalanceIntent fields (except createdAt, updatedAt)
    expect(intentToArbitrum!.id).to.be.a('string').and.not.be.empty;
    expect(intentToArbitrum!.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(intentToArbitrum!.destination).to.equal(DOMAIN_IDS.anvil2);
    expect(intentToArbitrum!.amount).to.equal(400000000n);
    expect(intentToArbitrum!.status).to.equal('in_progress');

    // Capture intent ID for completion verification
    const rebalanceIntentId = intentToArbitrum!.id;

    // Assert: Rebalance action was created with correct fields
    const inProgressActions = await context.tracker.getInProgressActions();
    expect(
      inProgressActions.length,
      'Should have at least 1 in-progress action',
    ).to.be.greaterThan(0);

    const actionToArbitrum = inProgressActions.find(
      (a) => a.destination === DOMAIN_IDS.anvil2,
    );
    expect(actionToArbitrum, 'Should have action destined for arbitrum').to
      .exist;

    // Assert all RebalanceAction fields (except createdAt, updatedAt, messageId, txHash)
    expect(actionToArbitrum!.id).to.be.a('string').and.not.be.empty;
    expect(actionToArbitrum!.intentId).to.equal(rebalanceIntentId);
    expect(actionToArbitrum!.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(actionToArbitrum!.destination).to.equal(DOMAIN_IDS.anvil2);
    expect(actionToArbitrum!.amount).to.equal(400000000n);
    expect(actionToArbitrum!.status).to.equal('in_progress');
    expect(actionToArbitrum!.messageId).to.be.a('string').and.not.be.empty;

    // Assert: Monitored route collateral on origin DECREASED (sent to bridge)
    const balancesAfterRebalance = await getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );

    // Assert exact balance: initial 10000 + user deposit 500 - rebalance 400 = 10100 USDC
    expect(
      balancesAfterRebalance.anvil1.toString(),
      'anvil1 collateral should be 10100 USDC after rebalance',
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
        messageId: actionToArbitrum!.messageId!,
        origin: 'anvil1',
        destination: 'anvil2',
      },
    );
    expect(
      rebalanceRelayResult.success,
      `Rebalance relay should succeed: ${rebalanceRelayResult.error}`,
    ).to.be.true;

    const userTransferRelay2 = await tryRelayMessage(
      context.multiProvider,
      hyperlaneCore,
      transferResult,
    );
    expect(
      userTransferRelay2.success,
      `User transfer relay should succeed: ${userTransferRelay2.error}`,
    ).to.be.true;

    // Sync actions to detect delivery and mark complete
    const blockTags2 = await context.getConfirmedBlockTags();
    await context.tracker.syncRebalanceActions(blockTags2);
    await context.tracker.syncTransfers(blockTags2);

    // Assert: Action is now complete
    const completedAction = await context.tracker.getRebalanceAction(
      actionToArbitrum!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    // Assert: Intent is now complete
    const completedIntent =
      await context.tracker.getRebalanceIntent(rebalanceIntentId);
    expect(completedIntent!.status).to.equal('complete');

    // Assert: No more in-progress actions
    const remainingActions = await context.tracker.getInProgressActions();
    expect(remainingActions.length).to.equal(0);

    const completedTransfer = await context.tracker.getTransfer(
      transferResult.messageId,
    );
    expect(completedTransfer!.status).to.equal('complete');
  });
});
