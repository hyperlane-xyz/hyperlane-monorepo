import { expect } from 'chai';
import { Connection } from '@solana/web3.js';
import { BigNumber, providers } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  SealevelCoreAdapter,
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
  type NativeDeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import {
  MAILBOX_PROGRAM_ID,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
  type SvmDeployedAddresses,
} from './fixtures/svm-routes.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { MixedTestRebalancerBuilder } from './harness/MixedTestRebalancerBuilder.js';
import { resetSnapshotsAndRefreshProviders } from './harness/SnapshotHelper.js';
import {
  classifyMixedChains,
  drainSvmWarpRoute,
  getMixedRouterBalances,
  getSvmWarpRouteBalance,
  relayMixedInventoryDeposits,
} from './harness/SvmTestHelpers.js';
import { SvmEvmLocalDeploymentManager } from './harness/SvmEvmLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import type { TestRebalancerContext } from './harness/TestRebalancer.js';

const SVM_CORE_E2E_PORT = 8900;
const ALL_MIXED_CHAINS = [...TEST_CHAINS, SVM_CHAIN_NAME] as const;

const LAMPORT_SCALE_TARGET = BigNumber.from('2000000000');
const LAMPORT_SCALE_MIN = BigNumber.from('1000000000');

function buildLamportStrategyConfig(): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: '0.000000001',
            target: '0.000000002',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: '0.000000001',
            target: '0.000000002',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: '0.000000001',
            target: '0.000000002',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        [SVM_CHAIN_NAME]: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

const BALANCE_SVM_DEFICIT = {
  evmBalances: {
    anvil1: '5000000000',
    anvil2: '5000000000',
    anvil3: '5000000000',
  },
  svmLamports: 0,
};

const BALANCE_EVM_ALL_DEFICIT_SVM_SURPLUS = {
  evmBalances: {
    anvil1: '0',
    anvil2: '0',
    anvil3: '0',
  },
  svmLamports: 5_000_000_000,
};

const BALANCE_MIXED_DEFICIT = {
  evmBalances: {
    anvil1: '5000000000',
    anvil2: '0',
    anvil3: '5000000000',
  },
  svmLamports: 0,
};

describe('Mixed EVM+SVM Core Inventory Rebalancer E2E', function () {
  this.timeout(600_000);

  let manager: SvmEvmLocalDeploymentManager;
  let evmAddresses: NativeDeployedAddresses;
  let svmAddresses: SvmDeployedAddresses;
  let svmPrivateKey: string;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let multiProvider: MultiProvider;
  let hyperlaneCore: HyperlaneCore;
  let svmConnection: Connection;
  let snapshotIds: Map<string, string>;
  let mockBridge: MockExternalBridge;

  async function executeCycle(context: TestRebalancerContext): Promise<void> {
    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    await context.orchestrator.executeCycle(event);
  }

  function normalizeMessageId(messageId: string): string {
    const lower = messageId.toLowerCase();
    return lower.startsWith('0x') ? lower : `0x${lower}`;
  }

  async function resolveSvmDispatchFromAction(
    context: TestRebalancerContext,
    intentId: string,
  ): Promise<{ txHash: string; messageId: string; destinationDomain: number }> {
    const intentActions = await context.tracker.getActionsForIntent(intentId);
    const svmDepositAction = intentActions.find(
      (action) =>
        action.type === 'inventory_deposit' && action.origin === SVM_DOMAIN_ID,
    );
    expect(svmDepositAction, 'Expected SVM-origin inventory deposit action').to
      .exist;

    let svmTxHash = svmDepositAction?.txHash;
    let svmMessageId = svmDepositAction?.messageId
      ? normalizeMessageId(svmDepositAction.messageId)
      : undefined;

    if (!svmTxHash || !svmMessageId) {
      await context.forkIndexer.sync(await context.getConfirmedBlockTags());
      const indexedActions = context.forkIndexer
        .getRebalanceActions()
        .filter(
          (action) =>
            action.origin_domain_id === SVM_DOMAIN_ID &&
            action.destination_domain_id === svmDepositAction!.destination,
        );
      const indexedCandidate = indexedActions.at(-1);
      if (indexedCandidate?.origin_tx_hash) {
        svmTxHash = indexedCandidate.origin_tx_hash;
      }
      if (indexedCandidate?.msg_id) {
        svmMessageId = normalizeMessageId(indexedCandidate.msg_id);
      }
    }

    expect(svmTxHash, 'Expected SVM tx hash for inventory deposit').to.exist;
    expect(svmMessageId, 'Expected SVM messageId for inventory deposit').to
      .exist;

    return {
      txHash: svmTxHash!,
      messageId: svmMessageId!,
      destinationDomain: svmDepositAction!.destination,
    };
  }

  before(async function () {
    manager = new SvmEvmLocalDeploymentManager(undefined, SVM_CORE_E2E_PORT);
    await manager.setup();

    const evmManager = manager.getEvmDeploymentManager();
    evmAddresses = evmManager.getContext().deployedAddresses;
    svmAddresses = manager.getSvmDeployedAddresses();
    svmPrivateKey = JSON.stringify(
      Array.from(manager.getSvmChainManager().getDeployerKeypair().secretKey),
    );

    localProviders = evmManager.getContext().providers;
    multiProvider = evmManager.getContext().multiProvider;
    svmConnection = manager.getSvmChainManager().getConnection();

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: evmAddresses.chains[chain].mailbox,
        interchainSecurityModule: evmAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    mockBridge = new MockExternalBridge(
      evmAddresses,
      multiProvider,
      hyperlaneCore,
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
    await drainSvmWarpRoute(manager, svmAddresses.warpTokenAta);
  });

  after(async function () {
    if (manager) await manager.teardown();
  });

  it('SVM inventory deposit - real SVM->EVM Hyperlane message', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances(BALANCE_SVM_DEFICIT)
      .withInventorySignerBalances({
        anvil1: '10000000000',
        anvil2: '10000000000',
        anvil3: '10000000000',
      })
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    const initialSvmAta = await getSvmWarpRouteBalance(
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    expect(activeIntents[0].destination).to.equal(SVM_DOMAIN_ID);
    expect(activeIntents[0].amount).to.equal(LAMPORT_SCALE_TARGET.toBigInt());

    const inProgressActions = await context.tracker.getInProgressActions();
    const depositAction = inProgressActions.find(
      (action) => action.type === 'inventory_deposit',
    );
    expect(depositAction).to.exist;
    expect(depositAction!.origin).to.equal(SVM_DOMAIN_ID);

    const dispatchInfo = await resolveSvmDispatchFromAction(
      context,
      activeIntents[0].id,
    );
    const svmTx = await svmConnection.getTransaction(dispatchInfo.txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(svmTx, 'Expected SVM dispatch tx on local validator').to.exist;

    const parsedDispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      svmTx?.meta?.logMessages ?? [],
    ).map((dispatch) => normalizeMessageId(dispatch.messageId));
    expect(parsedDispatches.includes(dispatchInfo.messageId)).to.be.true;

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const destinationChain = multiProvider.getChainName(
      dispatchInfo.destinationDomain,
    );
    const delivered = await hyperlaneCore
      .getContracts(destinationChain)
      .mailbox.delivered(dispatchInfo.messageId);
    expect(delivered).to.be.true;

    const finalBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    const finalSvmAta = await getSvmWarpRouteBalance(
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    expect(finalBalances[SVM_CHAIN_NAME].gt(initialBalances[SVM_CHAIN_NAME])).to
      .be.true;
    expect(finalSvmAta > initialSvmAta).to.be.true;

    const chainClassification = classifyMixedChains(
      SVM_CHAIN_NAME,
      depositAction!,
      ALL_MIXED_CHAINS,
    );
    expect(chainClassification.surplusChain).to.not.equal(SVM_CHAIN_NAME);
  });

  it('SVM and EVM both in deficit - sequential intent processing', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances(BALANCE_MIXED_DEFICIT)
      .withInventorySignerBalances({
        anvil1: '10000000000',
        anvil2: '10000000000',
        anvil3: '10000000000',
      })
      .withMockExternalBridge(mockBridge)
      .build();

    const initialBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const svmIntents =
      await context.tracker.getRebalanceIntentsByDestination(SVM_DOMAIN_ID);
    const anvil2Intents =
      await context.tracker.getRebalanceIntentsByDestination(DOMAIN_IDS.anvil2);
    expect(svmIntents.length).to.be.greaterThan(0);
    expect(anvil2Intents.length).to.be.greaterThan(0);

    const latestSvmIntent = svmIntents.sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0];
    const latestAnvil2Intent = anvil2Intents.sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0];
    expect(['in_progress', 'complete']).to.include(latestSvmIntent.status);
    expect(['in_progress', 'complete']).to.include(latestAnvil2Intent.status);

    const svmDispatchInfo = await resolveSvmDispatchFromAction(
      context,
      latestSvmIntent.id,
    );
    const svmTx = await svmConnection.getTransaction(svmDispatchInfo.txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(svmTx).to.exist;

    const svmLogMessageIds = SealevelCoreAdapter.parseMessageDispatchLogs(
      svmTx?.meta?.logMessages ?? [],
    ).map((dispatch) => normalizeMessageId(dispatch.messageId));
    expect(svmLogMessageIds.includes(svmDispatchInfo.messageId)).to.be.true;

    const svmDestinationChain = multiProvider.getChainName(
      svmDispatchInfo.destinationDomain,
    );
    const svmDelivered = await hyperlaneCore
      .getContracts(svmDestinationChain)
      .mailbox.delivered(svmDispatchInfo.messageId);
    expect(svmDelivered).to.be.true;

    const finalBalances = await getMixedRouterBalances(
      localProviders,
      evmAddresses,
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    expect(finalBalances[SVM_CHAIN_NAME].gt(initialBalances[SVM_CHAIN_NAME])).to
      .be.true;
    expect(finalBalances.anvil2.gt(initialBalances.anvil2)).to.be.true;
  });

  it('EVM all deficit - SVM as real bridge source', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances(BALANCE_EVM_ALL_DEFICIT_SVM_SURPLUS)
      .withInventorySignerBalances({
        anvil1: '0',
        anvil2: '0',
        anvil3: '0',
      })
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    const movementAction = inProgressActions.find(
      (action) => action.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.origin).to.equal(SVM_DOMAIN_ID);
    expect(movementAction!.amount >= LAMPORT_SCALE_MIN.toBigInt()).to.be.true;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(completedMovement).to.exist;
    expect(completedMovement!.origin).to.equal(SVM_DOMAIN_ID);
    expect(completedMovement!.status).to.equal('complete');
    expect(completedMovement!.txHash).to.exist;
    expect(completedMovement!.txHash!.startsWith('0x')).to.be.false;
    expect(completedMovement!.txHash).to.match(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('SVM bridge failure + retry', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances(BALANCE_EVM_ALL_DEFICIT_SVM_SURPLUS)
      .withInventorySignerBalances({
        anvil1: '0',
        anvil2: '0',
        anvil3: '0',
      })
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

    const partialAfterRetry =
      await context.tracker.getPartiallyFulfilledInventoryIntents();
    expect(partialAfterRetry.length).to.equal(1);
    const actionsAfterRetry = await context.tracker.getActionsForIntent(
      partialAfterRetry[0].intent.id,
    );
    const retryMovement = actionsAfterRetry.find(
      (action) => action.type === 'inventory_movement',
    );
    expect(retryMovement).to.exist;
    expect(retryMovement!.origin).to.equal(SVM_DOMAIN_ID);
    expect(retryMovement!.status).to.equal('complete');
    expect(retryMovement!.txHash).to.exist;
    expect(retryMovement!.txHash!.startsWith('0x')).to.be.false;
    expect(retryMovement!.txHash).to.match(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  // TODO: Add EVM→SVM delivery scenario when InboxProcess instruction builder is available
});
