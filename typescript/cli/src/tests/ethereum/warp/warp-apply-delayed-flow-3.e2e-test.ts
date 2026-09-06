import { expect } from 'chai';
import { ethers, Wallet } from 'ethers';

import { DelayedFlowRouterHookIsm__factory } from '@hyperlane-xyz/core';
import {
  type CallData,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
} from '../../../submitters/types.js';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { hyperlaneRelayer, stopRelayer } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCheck,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

import {
  countQueuedMessages,
  expectMessageDelivered,
  waitForQueuedMessage,
} from './delayedFlowHelpers.js';

import {
  domainOf,
  FILE_STRATEGY_PATH,
  FILE_SUBMITTER_OUTPUT_PATH,
  providerFor,
  setupDelayedFlowTest,
  SYMBOL,
  WARP_DEPLOY_PATH,
  WARP_ID,
} from './delayedFlowApplyHelpers.js';

describe('hyperlane warp apply with DelayedFlowRouterHookIsm e2e tests', async function () {
  this.timeout(5 * DEFAULT_E2E_TEST_TIMEOUT);

  const {
    deployerAddress,
    delayedFlowIsmConfig,
    delayedFlowHookConfig,
    expectMutualEnrollment,
    addressesByChain,
    deployPlainRoute,
  } = setupDelayedFlowTest();

  it('adds a DelayedFlowRouterHookIsm to an existing route, then enrolls a newly extended chain', async () => {
    await deployPlainRoute();

    // Scenario A: edit the config to add the hybrid on both chains.
    const withDelayedFlow: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: delayedFlowHookConfig(),
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: delayedFlowHookConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, withDelayedFlow);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    // One apply executes enrollment, hook, and ISM updates in each chain's batch.
    await hyperlaneWarpApply(WARP_ID);

    // Both instances exist, are paired with their router, and are mutually
    // enrolled — the enrollment the user should not have to configure.
    const dfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    // warp check must converge on the same config that was applied.
    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    // A second apply is a no-op.
    const secondApply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
    }).nothrow();
    expect(secondApply.exitCode).to.equal(0);
    expect(secondApply.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );

    // Restrict the relayer to the route's chains, but allow every sender and
    // recipient on them so both token and DFR-to-DFR messages are relayed.
    const relayer = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3]);
    try {
      const queuedBefore = await countQueuedMessages(dfrByChain[CHAIN_NAME_3]);
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const queuedId = await waitForQueuedMessage(
        dfrByChain[CHAIN_NAME_3],
        queuedBefore,
      );
      expect(
        await dfrByChain[CHAIN_NAME_2].lastCreditedNonce(),
      ).to.be.greaterThan(0);
      await expectMessageDelivered(
        providerFor(CHAIN_NAME_3),
        addressesByChain[CHAIN_NAME_3].mailbox,
        queuedId,
      );
    } finally {
      await stopRelayer(relayer);
    }

    // Scenario B: extend the DFR route to a third chain.
    const extendedConfig: WarpRouteDeployConfig =
      readYamlOrJson(WARP_DEPLOY_PATH);
    extendedConfig[CHAIN_NAME_4] = {
      type: TokenType.synthetic,
      // Token metadata is supplied explicitly for the new chain, as in the
      // other extension e2e tests.
      name: 'Ether',
      symbol: SYMBOL,
      decimals: 18,
      mailbox: addressesByChain[CHAIN_NAME_4].mailbox,
      owner: deployerAddress,
      interchainSecurityModule: delayedFlowIsmConfig(),
      hook: delayedFlowHookConfig(),
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, extendedConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    await hyperlaneWarpApply(WARP_ID);

    // The new chain enrolls both existing instances AND both existing
    // instances enroll the new one.
    const extendedDfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);

    // The freshly deployed instance ends up under the configured owner.
    expect(
      (await extendedDfrByChain[CHAIN_NAME_4].owner()).toLowerCase(),
    ).to.equal(deployerAddress.toLowerCase());

    const extendedCheckOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(extendedCheckOutput.exitCode).to.equal(0);
    expect(extendedCheckOutput.text()).to.include('No violations found');

    // Delivery works on a leg involving the newly extended chain.
    const extendedRelayer = hyperlaneRelayer([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    try {
      const queuedBefore = await countQueuedMessages(
        extendedDfrByChain[CHAIN_NAME_4],
      );
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_4,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const extendedQueuedId = await waitForQueuedMessage(
        extendedDfrByChain[CHAIN_NAME_4],
        queuedBefore,
      );
      await expectMessageDelivered(
        providerFor(CHAIN_NAME_4),
        addressesByChain[CHAIN_NAME_4].mailbox,
        extendedQueuedId,
      );
    } finally {
      await stopRelayer(extendedRelayer);
    }

    // Enrollment transactions must ride whichever submitter the strategy
    // configures for the chain rather than assuming a deployer-signed
    // JSON-RPC send — that is what makes a Safe/ICA-owned instance workable.
    // Introduce drift, then apply under a FILE submitter and assert the
    // enrollment lands in the written batch instead of on-chain.
    const anvil2Signer = new Wallet(ANVIL_KEY).connect(
      providerFor(CHAIN_NAME_2),
    );
    const anvil2Dfr = DelayedFlowRouterHookIsm__factory.connect(
      extendedDfrByChain[CHAIN_NAME_2].address,
      anvil2Signer,
    );
    const unenrollTx = await anvil2Dfr.unenrollRemoteRouter(
      domainOf(CHAIN_NAME_3),
    );
    await unenrollTx.wait();
    expect(await anvil2Dfr.routers(domainOf(CHAIN_NAME_3))).to.equal(
      ethers.constants.HashZero,
    );

    const fileStrategy: ExtendedChainSubmissionStrategy = {
      [CHAIN_NAME_2]: {
        submitter: {
          type: CustomTxSubmitterType.FILE,
          chain: CHAIN_NAME_2,
          filepath: FILE_SUBMITTER_OUTPUT_PATH,
        },
      },
    };
    writeYamlOrJson(FILE_STRATEGY_PATH, fileStrategy);

    const strategyApply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
      strategyUrl: FILE_STRATEGY_PATH,
      receiptsDir: TEMP_PATH,
    }).nothrow();
    expect(strategyApply.exitCode).to.equal(0);

    // Hybrid enrollment uses the same ordered per-chain FILE batch as every
    // other non-fee mutation.
    const batch: CallData[] = readYamlOrJson(FILE_SUBMITTER_OUTPUT_PATH);
    const enrollSelector =
      DelayedFlowRouterHookIsm__factory.createInterface().getSighash(
        'enrollRemoteRouters',
      );
    const enrollmentTx = batch.find(
      (tx) =>
        tx.to.toLowerCase() === anvil2Dfr.address.toLowerCase() &&
        tx.data.startsWith(enrollSelector),
    );
    assert(
      enrollmentTx,
      'Expected the DFR enrollment tx in the file submitter batch',
    );

    // The batch was written, not executed: the drift is still on-chain.
    expect(await anvil2Dfr.routers(domainOf(CHAIN_NAME_3))).to.equal(
      ethers.constants.HashZero,
    );
  });
});
