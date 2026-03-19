import { expect } from 'chai';

import { ExternalBridgeType } from '../config/types.js';

import { MAILBOX_PROGRAM_ID, SVM_DOMAIN_ID } from './fixtures/svm-routes.js';
import {
  COLLATERAL_EXPECTED_DEFICIT_USDC,
  COLLATERAL_TARGET_AMOUNT_USDC,
  buildMixedCollateralStrategyConfig,
} from './fixtures/svm-collateral-routes.js';
import { MixedCollateralTestRebalancerBuilder } from './harness/MixedCollateralTestRebalancerBuilder.js';
import { relayMixedInventoryDeposits } from './harness/SvmTestHelpers.js';
import {
  type MixedCollateralTestSetup,
  createMixedCollateralTestSetup,
  resetMixedCollateralTestState,
  teardownMixedCollateralTest,
  executeCycle,
  getSvmEscrowBalance,
} from './harness/MixedCollateralTestSetup.js';

const COLLATERAL_E2E_PORT = 8911;

describe('Mixed SVM+EVM Collateral E2E — Test 2: Partial Deposit', function () {
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

  it('handles partial SVM deposit, bridges inventory from EVM, then completes', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(setup.manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_SVM_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_PARTIAL_ANVIL2')
      .withMockExternalBridge(setup.mockBridge)
      .build();

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      setup.localProviders,
      setup.multiProvider,
      setup.hyperlaneCore,
      setup.svmConnection,
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
    const depositActions = deposits.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(depositActions.length).to.equal(1);
    expect(depositActions[0].origin).to.equal(SVM_DOMAIN_ID);

    await executeCycle(context);

    const preSyncMovements = await context.tracker.getInProgressActions();
    const movementActions = preSyncMovements.filter(
      (a) => a.type === 'inventory_movement',
    );
    expect(movementActions.length).to.be.greaterThanOrEqual(1);

    await context.tracker.syncInventoryMovementActions({
      [ExternalBridgeType.LiFi]: setup.mockBridge,
    });

    for (const action of movementActions) {
      const synced = await context.tracker.getRebalanceAction(action.id);
      expect(synced!.status).to.equal('complete');
    }

    // Simulate bridge delivery: mint the bridged amount to SVM signer's ATA
    // (the mock bridge confirms EVM dispatch but can't relay to SVM)
    const bridgedTotal = movementActions.reduce((sum, a) => sum + a.amount, 0n);
    await setup.manager.mintSplToInventorySigner(bridgedTotal);

    await executeCycle(context);
    await relayMixedInventoryDeposits(
      context,
      setup.localProviders,
      setup.multiProvider,
      setup.hyperlaneCore,
      setup.svmConnection,
      MAILBOX_PROGRAM_ID,
    );

    const completedIntent = await context.tracker.getRebalanceIntent(
      partialIntents[0].intent.id,
    );
    expect(completedIntent!.status).to.equal('complete');

    const finalActions = await context.tracker.getActionsForIntent(
      partialIntents[0].intent.id,
    );
    expect(finalActions.length).to.be.greaterThanOrEqual(3);
    const allDeposits = finalActions.filter(
      (a) => a.type === 'inventory_deposit',
    );
    expect(allDeposits.length).to.equal(2);
    const totalDeposited = allDeposits.reduce((sum, a) => sum + a.amount, 0n);
    expect(totalDeposited).to.equal(partialIntents[0].intent.amount);

    const finalSvmEscrow = await getSvmEscrowBalance(
      setup.svmConnection,
      setup.manager.getDeployedAddresses().svm.escrowPda,
    );
    expect(finalSvmEscrow >= COLLATERAL_TARGET_AMOUNT_USDC).to.be.true;
  });
});
