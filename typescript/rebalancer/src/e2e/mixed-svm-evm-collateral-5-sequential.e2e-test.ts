import { expect } from 'chai';

import { DOMAIN_IDS } from './fixtures/routes.js';
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
} from './harness/MixedCollateralTestSetup.js';

const COLLATERAL_E2E_PORT = 8941;

describe('Mixed SVM+EVM Collateral E2E — Test 5: Sequential Intents', function () {
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

  it('processes one SVM intent at a time when multiple chains are in deficit', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(setup.manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_MIXED_DEFICIT')
      .withInventorySignerBalances('COLLATERAL_SIGNER_FUNDED')
      .withMockExternalBridge(setup.mockBridge)
      .build();

    await executeCycle(context);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(
      activeIntents.length,
      'Only one intent should be active at a time',
    ).to.equal(1);

    await relayMixedInventoryDeposits(
      context,
      setup.localProviders,
      setup.multiProvider,
      setup.hyperlaneCore,
      setup.svmConnection,
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
});
