import { expect } from 'chai';
import { Connection } from '@solana/web3.js';
import { providers } from 'ethers';

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
  drainSvmWarpRoute,
  getSvmWarpRouteBalance,
  relayMixedInventoryDeposits,
} from './harness/SvmTestHelpers.js';
import { SvmEvmLocalDeploymentManager } from './harness/SvmEvmLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import type { TestRebalancerContext } from './harness/TestRebalancer.js';

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

function buildEthScaleStrategyConfig(): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: '1',
            target: '2',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: '1',
            target: '2',
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

describe('Mixed EVM+SVM Inventory Rebalancer Advanced E2E', function () {
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

  before(async function () {
    // Uses default port 8899
    manager = new SvmEvmLocalDeploymentManager();
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

  // ── Scenario 5 ──

  it('SVM surplus drives EVM deficit resolution with real bridge transfer', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances({
        evmBalances: { anvil1: '0', anvil2: '0', anvil3: '0' },
        svmLamports: 5_000_000_000,
      })
      .withInventorySignerBalances({
        anvil1: '10000000000',
        anvil2: '10000000000',
        anvil3: '10000000000',
      })
      .withMockExternalBridge(mockBridge)
      .build();

    // Cycle 1: First EVM deficit processed — SVM is bridge source
    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.be.greaterThan(0);

    const movementAction = inProgressActions.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction, 'Expected SVM-source bridge movement').to.exist;
    expect(movementAction!.origin).to.equal(SVM_DOMAIN_ID);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(completedMovement!.status).to.equal('complete');

    // The SVM bridge txHash must be a real Solana signature (base58, not 0x)
    expect(completedMovement!.txHash).to.exist;
    expect(
      completedMovement!.txHash!.startsWith('0x'),
      'SVM bridge txHash should be a real Solana base58 signature',
    ).to.be.false;

    // Verify the SVM transaction actually exists on-chain
    const svmTx = await svmConnection.getTransaction(
      completedMovement!.txHash!,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    );
    expect(svmTx, 'Expected real SVM tx on local validator').to.exist;

    // Second cycle: only one intent processed at a time
    await executeCycle(context);
    const activeAfterSecond = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeAfterSecond.length,
      'Only one intent should be active at a time',
    ).to.be.at.most(1);
  });

  // ── Scenario 6 ──

  it('multiple bridge sources including SVM contribute to EVM deficit', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildLamportStrategyConfig())
      .withBalances({
        evmBalances: {
          anvil1: '2000000000',
          anvil2: '0',
          anvil3: '2000000000',
        },
        svmLamports: 2_000_000_000,
      })
      .withInventorySignerBalances({
        anvil1: '2000000000',
        anvil2: '0',
        anvil3: '2000000000',
      })
      .withMockExternalBridge(mockBridge)
      .build();

    // Cycle 1: bridge movements from multiple sources to cover anvil2 deficit
    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    const movementActions = inProgressActions.filter(
      (a) => a.type === 'inventory_movement',
    );

    // At least one movement should originate from SVM
    const svmMovement = movementActions.find((a) => a.origin === SVM_DOMAIN_ID);
    expect(svmMovement, 'Expected at least one bridge movement from SVM').to
      .exist;

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedSvmMovement = await context.tracker.getRebalanceAction(
      svmMovement!.id,
    );
    expect(completedSvmMovement!.status).to.equal('complete');

    // Verify SVM bridge tx is a real Solana signature
    expect(completedSvmMovement!.txHash).to.exist;
    expect(
      completedSvmMovement!.txHash!.startsWith('0x'),
      'SVM bridge txHash must be a real Solana base58 signature',
    ).to.be.false;
  });

  // ── Scenario 7 ──

  it('bridges inventory from SVM when all EVM chains are in deficit', async function () {
    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildEthScaleStrategyConfig())
      .withBalances('INVENTORY_EVM_ALL_DEFICIT')
      .withInventorySignerBalances('SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);

    const inProgressActions = await context.tracker.getInProgressActions();
    expect(inProgressActions.length).to.equal(1);
    const movementAction = inProgressActions.find(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementAction).to.exist;
    expect(movementAction!.origin).to.equal(SVM_DOMAIN_ID);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    const completedMovement = await context.tracker.getRebalanceAction(
      movementAction!.id,
    );
    expect(completedMovement!.status).to.equal('complete');

    // Verify the bridge tx is a real Solana signature (not synthetic 0x hash)
    expect(completedMovement!.txHash).to.exist;
    expect(
      completedMovement!.txHash!.startsWith('0x'),
      'SVM bridge txHash should be a real Solana base58 signature',
    ).to.be.false;
  });

  // ── Scenario 8 ──

  it('executes real SVM-origin transferRemote, indexes dispatch, and relays to EVM', async function () {
    await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(buildEthScaleStrategyConfig())
      .withBalances('INVENTORY_BALANCED')
      .withInventorySignerBalances('SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    const currentSvmBalance = await getSvmWarpRouteBalance(
      svmConnection,
      svmAddresses.warpTokenAta,
    );
    const scenario8Deficit = 2_000_000_000n;

    const scenario8Strategy = buildEthScaleStrategyConfig();
    const scenario8SvmChainConfig = scenario8Strategy[0].chains[SVM_CHAIN_NAME];
    if (
      !('minAmount' in scenario8SvmChainConfig) ||
      !scenario8SvmChainConfig.minAmount
    ) {
      throw new Error('Scenario 8 requires minAmount strategy for SVM chain');
    }
    scenario8SvmChainConfig.minAmount = {
      min: (currentSvmBalance + scenario8Deficit).toString(),
      target: (currentSvmBalance + scenario8Deficit + 1n).toString(),
      type: RebalancerMinAmountType.Absolute,
    };

    const context = await new MixedTestRebalancerBuilder()
      .withManager(manager)
      .withEvmAddresses(evmAddresses)
      .withSvmAddresses(svmAddresses)
      .withSvmPrivateKey(svmPrivateKey)
      .withStrategyConfig(scenario8Strategy)
      .withBalances('INVENTORY_BALANCED')
      .withInventorySignerBalances('SIGNER_ZERO_ALL')
      .withMockExternalBridge(mockBridge)
      .build();

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: mockBridge,
    });

    await executeCycle(context);

    const intentsToSvm = (
      await context.tracker.getRebalanceIntentsByDestination(SVM_DOMAIN_ID)
    ).sort((a, b) => b.createdAt - a.createdAt);
    const targetIntent = intentsToSvm[0];
    expect(
      targetIntent,
      'Expected a rebalance intent targeting SVM in Scenario 8',
    ).to.exist;

    const targetEvmDomain = targetIntent!.origin;
    const targetIntentActions = await context.tracker.getActionsForIntent(
      targetIntent!.id,
    );
    const svmDeposit = targetIntentActions.find(
      (action) =>
        action.type === 'inventory_deposit' &&
        action.origin === SVM_DOMAIN_ID &&
        action.destination === targetEvmDomain,
    );
    expect(
      svmDeposit,
      'Expected SVM-origin inventory deposit action for target EVM domain',
    ).to.exist;
    const destinationChain = multiProvider.getChainName(targetEvmDomain);
    const destinationMailbox =
      hyperlaneCore.getContracts(destinationChain).mailbox;

    let svmTxHash = svmDeposit?.txHash;
    let svmMessageId = svmDeposit?.messageId?.toLowerCase();

    if (!svmTxHash || !svmMessageId) {
      await context.forkIndexer.sync(await context.getConfirmedBlockTags());
      const indexedBeforeRelay = context.forkIndexer.getRebalanceActions();
      const matchingIndexedActions = indexedBeforeRelay.filter(
        (action) =>
          action.origin_domain_id === SVM_DOMAIN_ID &&
          action.destination_domain_id === targetEvmDomain,
      );
      const indexedCandidate = matchingIndexedActions.at(-1);
      if (indexedCandidate?.origin_tx_hash) {
        svmTxHash = indexedCandidate.origin_tx_hash;
      }
      if (indexedCandidate?.msg_id) {
        const lower = indexedCandidate.msg_id.toLowerCase();
        svmMessageId = lower.startsWith('0x') ? lower : `0x${lower}`;
      }
    }

    expect(svmTxHash, 'Expected SVM tx hash for inventory deposit').to.exist;
    expect(svmMessageId, 'Expected SVM messageId for inventory deposit').to
      .exist;

    const svmTx = await svmConnection.getTransaction(svmTxHash!, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(svmTx, 'Expected SVM origin transfer tx on local validator').to
      .exist;

    const svmDispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      svmTx?.meta?.logMessages ?? [],
    );
    const normalizedDispatchMessageIds = svmDispatches.map((dispatch) => {
      const lower = dispatch.messageId.toLowerCase();
      return lower.startsWith('0x') ? lower : `0x${lower}`;
    });
    expect(
      normalizedDispatchMessageIds.includes(svmMessageId!),
      'Expected SVM tx logs to contain dispatched messageId',
    ).to.be.true;

    await context.forkIndexer.sync(await context.getConfirmedBlockTags());
    const indexedBeforeRelay = context.forkIndexer.getRebalanceActions();
    const normalizedIndexedMessageIds = indexedBeforeRelay
      .filter((action) => action.origin_domain_id === SVM_DOMAIN_ID)
      .map((action) => {
        const lower = action.msg_id.toLowerCase();
        return lower.startsWith('0x') ? lower : `0x${lower}`;
      });
    expect(
      normalizedIndexedMessageIds.includes(svmMessageId!),
      'Expected SvmForkIndexer to index SVM-origin dispatch before relay sync',
    ).to.be.true;

    await relayMixedInventoryDeposits(
      context,
      localProviders,
      multiProvider,
      hyperlaneCore,
      svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    if (svmDeposit?.id) {
      const completedDeposit = await context.tracker.getRebalanceAction(
        svmDeposit.id,
      );
      expect(completedDeposit!.status).to.equal('complete');
    }

    const delivered = await destinationMailbox.delivered(svmMessageId!);
    expect(
      delivered,
      'Expected EVM mailbox to mark SVM-origin message delivered',
    ).to.be.true;

    const targetIntentId = svmDeposit!.intentId;
    expect(targetIntentId).to.exist;
    const completedIntent = await context.tracker.getRebalanceIntent(
      targetIntentId!,
    );
    expect(['in_progress', 'complete']).to.include(completedIntent!.status);
  });

  // TODO: Add EVM→SVM delivery scenario when InboxProcess instruction builder is available
});
