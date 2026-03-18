import { expect } from 'chai';

import { SealevelCoreAdapter } from '@hyperlane-xyz/sdk';

import { MAILBOX_PROGRAM_ID, SVM_DOMAIN_ID } from './fixtures/svm-routes.js';
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

const COLLATERAL_E2E_PORT = 8901;

describe('Mixed SVM+EVM Collateral E2E — Test 1: Transfer', function () {
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

  it('transfers USDC collateral when SVM escrow is below minimum', async function () {
    const addresses = setup.manager.getDeployedAddresses();

    const initialSvmEscrow = await getSvmEscrowBalance(
      setup.svmConnection,
      addresses.svm.escrowPda,
    );

    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(setup.manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_SVM_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(setup.mockBridge)
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

    const svmTx = await setup.svmConnection.getTransaction(svmTxHash!, {
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
      setup.localProviders,
      setup.multiProvider,
      setup.hyperlaneCore,
      setup.svmConnection,
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
      setup.svmConnection,
      addresses.svm.escrowPda,
    );
    expect(
      finalSvmEscrow > initialSvmEscrow,
      'SVM collateral escrow should increase after deposit',
    ).to.be.true;
  });
});
