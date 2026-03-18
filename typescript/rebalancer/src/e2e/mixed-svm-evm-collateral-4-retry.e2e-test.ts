import { expect } from 'chai';

import { ExternalBridgeType } from '../config/types.js';

import { SVM_DOMAIN_ID } from './fixtures/svm-routes.js';
import { buildMixedCollateralStrategyConfig } from './fixtures/svm-collateral-routes.js';
import { MixedCollateralTestRebalancerBuilder } from './harness/MixedCollateralTestRebalancerBuilder.js';
import {
  type MixedCollateralTestSetup,
  createMixedCollateralTestSetup,
  resetMixedCollateralTestState,
  teardownMixedCollateralTest,
  executeCycle,
} from './harness/MixedCollateralTestSetup.js';

const COLLATERAL_E2E_PORT = 8931;

describe('Mixed SVM+EVM Collateral E2E — Test 4: Retry Bridge', function () {
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

  it('retries SVM bridge after initial failure', async function () {
    const context = await new MixedCollateralTestRebalancerBuilder()
      .withManager(setup.manager)
      .withStrategyConfig(buildMixedCollateralStrategyConfig())
      .withBalances('COLLATERAL_INVENTORY_EVM_ALL_DEFICIT')
      .withInventorySignerBalances({
        anvil1: '0',
        anvil2: '0',
        anvil3: '0',
        sealeveltest1: '20000000000',
      })
      .withMockExternalBridge(setup.mockBridge)
      .build();

    setup.mockBridge.failNextExecute();
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
      [ExternalBridgeType.LiFi]: setup.mockBridge,
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
});
