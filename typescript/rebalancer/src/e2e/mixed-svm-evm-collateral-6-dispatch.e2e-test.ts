import { expect } from 'chai';

import { SealevelCoreAdapter } from '@hyperlane-xyz/sdk';

import {
  ExternalBridgeType,
  RebalancerMinAmountType,
} from '../config/types.js';

import {
  MAILBOX_PROGRAM_ID,
  SVM_CHAIN_NAME,
  SVM_DOMAIN_ID,
} from './fixtures/svm-routes.js';
import { buildMixedCollateralStrategyConfig } from './fixtures/svm-collateral-routes.js';
import { MixedCollateralTestRebalancerBuilder } from './harness/MixedCollateralTestRebalancerBuilder.js';
import { relayMixedInventoryDeposits } from './harness/SvmTestHelpers.js';
import {
  type MixedCollateralTestSetup,
  createMixedCollateralTestSetup,
  resetMixedCollateralTestState,
  teardownMixedCollateralTest,
  executeCycle,
  normalizeMessageId,
  getSvmEscrowBalance,
} from './harness/MixedCollateralTestSetup.js';

const COLLATERAL_E2E_PORT = 8951;

describe('Mixed SVM+EVM Collateral E2E — Test 6: Dispatch Pipeline', function () {
  this.timeout(600_000);

  let setup: MixedCollateralTestSetup;

  before(async function () {
    setup = await createMixedCollateralTestSetup(COLLATERAL_E2E_PORT);
  });

  afterEach(async function () {
    await resetMixedCollateralTestState(setup);
  });

  after(async function () {
    await teardownMixedCollateralTest(setup);
  });

  it('executes real SVM-origin collateral transferRemote, indexes dispatch, and relays to EVM', async function () {
    const addresses = setup.manager.getDeployedAddresses();

    // With a fresh validator, escrow starts at 0.
    // We use COLLATERAL_INVENTORY_SVM_DEFICIT (escrow=0) and set min/target
    // to force a deficit that the signer can fill.
    const dynamicStrategy = buildMixedCollateralStrategyConfig();
    const svmChainConfig = dynamicStrategy[0].chains[SVM_CHAIN_NAME];
    if ('minAmount' in svmChainConfig && svmChainConfig.minAmount) {
      // Set min=1 USDC, target=2 USDC — escrow starts at 0, so deficit exists.
      // Signer has 20K USDC (COLLATERAL_SIGNER_FUNDED), so it can fill the deposit.
      svmChainConfig.minAmount = {
        min: '1',
        target: '2',
        type: RebalancerMinAmountType.Absolute,
      };
    }

    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(setup.manager)
      .withStrategyConfig(dynamicStrategy)
      .withBalances('COLLATERAL_INVENTORY_SVM_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(setup.mockBridge)
      .build();

    await executeCycle(context);
    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: setup.mockBridge,
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

    const svmTx = await setup.svmConnection.getTransaction(svmTxHash!, {
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
      setup.localProviders,
      setup.multiProvider,
      setup.hyperlaneCore,
      setup.svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedDeposit = await context.tracker.getRebalanceAction(
      svmDeposit!.id,
    );
    expect(completedDeposit!.status).to.equal('complete');

    if (svmMessageId) {
      const destDomain = svmDeposit!.destination;
      const destChain = setup.multiProvider.getChainName(destDomain);
      const delivered = await setup.hyperlaneCore
        .getContracts(destChain)
        .mailbox.delivered(svmMessageId);
      expect(
        delivered,
        'Expected EVM mailbox to mark SVM-origin message as delivered',
      ).to.be.true;
    }

    const finalSvmEscrow = await getSvmEscrowBalance(
      setup.svmConnection,
      addresses.svm.escrowPda,
    );
    expect(
      finalSvmEscrow > 0n,
      'SVM collateral escrow should increase after real deposit',
    ).to.be.true;
  });
});
