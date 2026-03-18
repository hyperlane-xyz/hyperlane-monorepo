import { expect } from 'chai';
import { Connection } from '@solana/web3.js';
import { providers } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  SealevelCoreAdapter,
  snapshot,
} from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../config/types.js';

import { DOMAIN_IDS, TEST_CHAINS } from './fixtures/routes.js';
import {
  MAILBOX_PROGRAM_ID,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
} from './fixtures/svm-routes.js';
import {
  COLLATERAL_EXPECTED_DEFICIT_USDC,
  COLLATERAL_TARGET_AMOUNT_USDC,
  buildMixedCollateralStrategyConfig,
} from './fixtures/svm-collateral-routes.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { MixedCollateralTestRebalancerBuilder } from './harness/MixedCollateralTestRebalancerBuilder.js';
import { resetSnapshotsAndRefreshProviders } from './harness/SnapshotHelper.js';
import { relayMixedInventoryDeposits } from './harness/SvmTestHelpers.js';
import { SvmCollateralEvmErc20LocalDeploymentManager } from './harness/SvmCollateralEvmErc20LocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import type { TestRebalancerContext } from './harness/TestRebalancer.js';

const COLLATERAL_E2E_PORT = 8900;

function normalizeMessageId(id: string): string {
  const lower = id.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

async function getSvmEscrowBalance(
  connection: Connection,
  escrowPda: string,
): Promise<bigint> {
  const result = await connection.getTokenAccountBalance(
    new (await import('@solana/web3.js')).PublicKey(escrowPda),
    'confirmed',
  );
  return BigInt(result.value.amount);
}

describe('Mixed SVM+EVM Collateral Inventory Rebalancer E2E', function () {
  this.timeout(600_000);

  let manager: SvmCollateralEvmErc20LocalDeploymentManager;
  let svmConnection: Connection;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let multiProvider: MultiProvider;
  let hyperlaneCore: HyperlaneCore;
  let snapshotIds: Map<string, string>;
  let mockBridge: MockExternalBridge;

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

  before(async function () {
    manager = new SvmCollateralEvmErc20LocalDeploymentManager(
      undefined,
      COLLATERAL_E2E_PORT,
    );
    await manager.setup();

    const addresses = manager.getDeployedAddresses();
    svmConnection = manager.getSvmChainManager().getConnection();

    const evmCtx = manager.getEvmDeploymentManager().getContext();
    localProviders = evmCtx.providers;
    multiProvider = evmCtx.multiProvider;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: addresses.chains[chain].mailbox,
        interchainSecurityModule: addresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    mockBridge = new MockExternalBridge(
      addresses,
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
    await resetSnapshotsAndRefreshProviders({
      localProviders,
      multiProvider,
      snapshotIds,
    });
  });

  after(async function () {
    if (manager) await manager.teardown();
  });

  it('transfers USDC collateral when SVM escrow is below minimum', async function () {
    const addresses = manager.getDeployedAddresses();

    const initialSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      addresses.svm.escrowPda,
    );

    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_SVM_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(SVM_DOMAIN_ID);
    expect(activeIntents[0].amount > 0n).to.be.true;

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    const depositAction = inProgressActions.find(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositAction).to.exist;
    expect(depositAction!.origin).to.equal(SVM_DOMAIN_ID);

    const svmTxHash = depositAction!.txHash;
    expect(svmTxHash, 'SVM deposit action should have txHash').to.exist;

    const svmTx = await svmConnection.getTransaction(svmTxHash!, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(svmTx, 'Expected SVM transfer tx on local validator').to.exist;

    const dispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      svmTx?.meta?.logMessages ?? [],
    );
    const msgId = depositAction!.messageId
      ? normalizeMessageId(depositAction!.messageId)
      : null;
    if (msgId) {
      const dispatchIds = dispatches.map((d) =>
        normalizeMessageId(d.messageId),
      );
      expect(
        dispatchIds.includes(msgId),
        'SVM tx logs should contain dispatched messageId',
      ).to.be.true;
    }

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedAction = await context.tracker.getRebalanceAction(
      depositAction!.id,
    );
    expect(completedAction!.status).to.equal('complete');

    const completedIntent = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const finalSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      addresses.svm.escrowPda,
    );
    expect(
      finalSvmEscrow > initialSvmEscrow,
      'SVM collateral escrow should increase after deposit',
    ).to.be.true;
  });

  it('handles partial SVM deposit, bridges inventory from EVM, then completes', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_SVM_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_PARTIAL_ANVIL2')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const partialIntents =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialIntents.length).to.equal(1);
    expect(partialIntents[0].completedAmount > 0n).to.be.true;
    expect(partialIntents[0].remaining > 0n).to.be.true;
    expect(
      partialIntents[0].completedAmount + partialIntents[0].remaining,
    ).to.equal(COLLATERAL_EXPECTED_DEFICIT_USDC);
    expect(partialIntents[0].intent.destination).to.equal(SVM_DOMAIN_ID);

    const deposits = await context.tracker.getActionsForIntent(
      partialIntents[0].intent.id,
    );
    expect(deposits.length).to.equal(1);
    expect(deposits[0].origin).to.equal(SVM_DOMAIN_ID);

    await executeCycle(context);

    const preSyncMovements = await context.tracker.getInProgressActions();
    expect(preSyncMovements.length).to.equal(1);
    const movementAction = preSyncMovements.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const syncedMovement = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(syncedMovement!.status).to.equal('complete');

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedIntent = await context.tracker.getRebalanceIntent(
      partialIntents[0].intent.id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const finalActions = await context.tracker.getActionsForIntent(
      partialIntents[0].intent.id,
    );
    expect(finalActions.length).to.equal(3);
    const allDeposits = finalActions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(allDeposits.length).to.equal(2);
    const totalDeposited = allDeposits.reduce((sum, a) => sum + a.amount, 0n);
    expect(totalDeposited).to.equal(partialIntents[0].intent.amount);

    const finalSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      manager.getDeployedAddresses().svm.escrowPda,
    );
    expect(finalSvmEscrow >= COLLATERAL_TARGET_AMOUNT_USDC).to.be.true;
  });

  it('bridges USDC from SVM when all EVM chains have low collateral balances', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_EVM_ALL_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    const addresses = manager.getDeployedAddresses();

    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    const svmMovement = inProgressActions.find(
      (a) => a.type === 'inventory_movement' && a.origin === SVM_DOMAIN_ID,
    );
    expect(
      svmMovement,
      'Expected bridge movement from SVM when all EVM routers are empty',
    ).to.exist;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      svmMovement!.id,
    );
    expect(completedMovement!.status).to.equal('complete');
    expect(completedMovement!.txHash).to.exist;
    expect(
      completedMovement!.txHash!.startsWith('0x'),
      'SVM bridge txHash should be Solana base58, not 0x-prefixed hex',
    ).to.be.false;

    const svmTx = await svmConnection.getTransaction(
      completedMovement!.txHash!,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    );
    expect(svmTx, 'SVM bridge tx should exist on local validator').to.exist;

    const finalSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      addresses.svm.escrowPda,
    );
    expect(finalSvmEscrow < BigInt('10000000000')).to.be.true;
  });

  it('retries SVM bridge after initial failure', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_EVM_ALL_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    mockBridge.failNextExecute();
    await executeCycle(context);

    const partialAfterFailure =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterFailure.length).to.equal(1);
    const actionsAfterFailure = await context.tracker.getActionsForIntent(
      partialAfterFailure[0].intent.id,
    );
    expect(actionsAfterFailure.length).to.equal(0);

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const actionsAfterRetry = await context.tracker.getActionsForIntent(
      partialAfterFailure[0].intent.id,
    );
    const retryMovement = actionsAfterRetry.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(retryMovement).to.exist;
    expect(retryMovement!.origin).to.equal(SVM_DOMAIN_ID);
    expect(retryMovement!.status).to.equal('complete');
    expect(retryMovement!.txHash).to.exist;
    expect(
      retryMovement!.txHash!.startsWith('0x'),
      'Retry SVM bridge txHash should be Solana base58',
    ).to.be.false;
  });

  it('processes one SVM intent at a time when multiple chains are in deficit', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_MIXED_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Only one intent should be active at a time',
    ).to.equal(1);

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedFirst = await context.tracker.getRebalanceIntent(
      activeIntents[0].id,
    );
    expect(['in_progress', 'complete']).to.include(completedFirst!.status);

    await executeCycle(context);

    const activeAfterSecond = await context.tracker.getActiveRebalanceIntents();
    expect(activeAfterSecond.length).to.be.at.most(1);

    const allIntentsSvm =
      await context.tracker.getRebalanceIntentsByDestination(SVM_DOMAIN_ID);
    const allIntentsAnvil2 =
      await context.tracker.getRebalanceIntentsByDestination(DOMAIN_IDS.anvil2);
    const totalIntents = allIntentsSvm.length + allIntentsAnvil2.length;
    expect(totalIntents).to.be.greaterThan(0);
  });

  it('executes real SVM-origin collateral transferRemote, indexes dispatch, and relays to EVM', async function () {
    const addresses = manager.getDeployedAddresses();

    const currentSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      addresses.svm.escrowPda,
    );

    const dynamicStrategy = buildMixedCollateralStrategyConfig();
    const svmChainConfig = dynamicStrategy[0].chains[SVM_CHAIN_NAME];
    if ('minAmount' in svmChainConfig && svmChainConfig.minAmount) {
      const currentBalanceUSDC = currentSvmEscrow / BigInt('1000000');
      const deficit = BigInt('10000');
      svmChainConfig.minAmount = {
        min: String(currentBalanceUSDC + deficit),
        target: String(currentBalanceUSDC + deficit + 1n),
        type: svmChainConfig.minAmount.type,
      };
    }

    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(manager)
      .withStrategyConfig(dynamicStrategy)
      .withBalances('COLLATERAL_INVENTORY_BALANCED')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });
    await executeCycle(context);

    const svmIntents =
      await context.tracker.getRebalanceIntentsByDestination(SVM_DOMAIN_ID);
    const targetIntent = svmIntents.sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0];
    expect(targetIntent, 'Expected rebalance intent targeting SVM chain').to
      .exist;

    const intentActions = await context.tracker.getActionsForIntent(
      targetIntent!.id,
    );
    const svmDeposit = intentActions.find(
      (a) => a.type === 'inventory_deposit' && a.origin === SVM_DOMAIN_ID,
    );
    expect(svmDeposit, 'Expected SVM-origin inventory deposit action').to.exist;

    const svmTxHash = svmDeposit!.txHash;
    const svmMessageId = svmDeposit!.messageId
      ? normalizeMessageId(svmDeposit!.messageId)
      : null;

    expect(svmTxHash, 'Expected SVM tx hash on deposit action').to.exist;

    const svmTx = await svmConnection.getTransaction(svmTxHash!, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(svmTx, 'Expected SVM origin tx on local validator').to.exist;

    const svmDispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      svmTx?.meta?.logMessages ?? [],
    );
    expect(svmDispatches.length).to.be.greaterThan(0);

    if (svmMessageId) {
      const normalizedDispatchIds = svmDispatches.map((d) =>
        normalizeMessageId(d.messageId),
      );
      expect(
        normalizedDispatchIds.includes(svmMessageId),
        'Expected SVM tx logs to contain dispatched messageId',
      ).to.be.true;
    }

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedDeposit = await context.tracker.getRebalanceAction(
      svmDeposit!.id,
    );
    expect(completedDeposit!.status).to.equal('complete');

    if (svmMessageId) {
      const destDomain = svmDeposit!.destination;
      const destChain = multiProvider.getChainName(destDomain);
      const delivered = await hyperlaneCore
        .getContracts(destChain)
        .mailbox.delivered(svmMessageId);
      expect(
        delivered,
        'Expected EVM mailbox to mark SVM-origin message as delivered',
      ).to.be.true;
    }

    const finalSvmEscrow = await getSvmEscrowBalance(
      svmConnection,
      addresses.svm.escrowPda,
    );
    expect(
      finalSvmEscrow > currentSvmEscrow,
      'SVM collateral escrow should increase after real deposit',
    ).to.be.true;
  });

  // TODO: Add EVM→SVM delivery scenario when InboxProcess instruction builder is available
});
