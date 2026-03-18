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
  getSvmEscrowBalance,
} from './harness/MixedCollateralTestSetup.js';

const COLLATERAL_E2E_PORT = 8921;

describe('Mixed SVM+EVM Collateral E2E — Test 3: SVM Bridge', function () {
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

  it('bridges USDC from SVM when all EVM chains have low collateral balances', async function () {
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

    const addresses = setup.manager.getDeployedAddresses();

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
      [ExternalBridgeType.LiFi]: setup.mockBridge,
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

    const svmTx = await setup.svmConnection.getTransaction(
      completedMovement!.txHash!,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    );
    expect(svmTx, 'SVM bridge tx should exist on local validator').to.exist;

    const finalSvmEscrow = await getSvmEscrowBalance(
      setup.svmConnection,
      addresses.svm.escrowPda,
    );
    expect(finalSvmEscrow < BigInt('10000000000')).to.be.true;
  });
});
