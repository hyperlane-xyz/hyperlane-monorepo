import { expect } from 'chai';
import { ethers, Wallet } from 'ethers';

import {
  type ChainMap,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCheck,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

import {
  domainOf,
  providerFor,
  ROUTE_CHAINS,
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
    nestedDelayedFlowHookConfig,
    expectMutualEnrollment,
    plainRouteConfig,
    deployPlainRoute,
  } = setupDelayedFlowTest();

  it('rejects invalid delayed-flow peers before spending gas', async () => {
    await deployPlainRoute();

    const invalidConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        ...plainRouteConfig()[CHAIN_NAME_2],
        interchainSecurityModule: delayedFlowIsmConfig({
          remoteIsms: { [CHAIN_NAME_3]: ethers.constants.HashZero },
        }),
        hook: delayedFlowHookConfig({
          remoteIsms: { [CHAIN_NAME_3]: ethers.constants.HashZero },
        }),
      },
      [CHAIN_NAME_3]: {
        ...plainRouteConfig()[CHAIN_NAME_3],
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: delayedFlowHookConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, invalidConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    const noncesBefore: ChainMap<number> = {};
    for (const chain of ROUTE_CHAINS) {
      noncesBefore[chain] =
        await providerFor(chain).getTransactionCount(deployerAddress);
    }
    const apply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
    }).nothrow();
    expect(apply.exitCode).to.not.equal(0);
    expect(apply.text()).to.include('remoteIsms');
    for (const chain of ROUTE_CHAINS) {
      expect(
        await providerFor(chain).getTransactionCount(deployerAddress),
      ).to.equal(noncesBefore[chain]);
    }
  });

  it('removes an enrolled delayed-flow domain missing from chain metadata', async () => {
    await deployPlainRoute();

    const delayedFlowConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        ...plainRouteConfig()[CHAIN_NAME_2],
        interchainSecurityModule: delayedFlowIsmConfig({ remoteIsms: {} }),
        hook: delayedFlowHookConfig({ remoteIsms: {} }),
      },
      [CHAIN_NAME_3]: {
        ...plainRouteConfig()[CHAIN_NAME_3],
        interchainSecurityModule: delayedFlowIsmConfig({ remoteIsms: {} }),
        hook: delayedFlowHookConfig({ remoteIsms: {} }),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, delayedFlowConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });
    await hyperlaneWarpApply(WARP_ID);

    const dfrByChain = await expectMutualEnrollment(ROUTE_CHAINS);
    const unknownDomain = 987654;
    const anvil2Dfr = dfrByChain[CHAIN_NAME_2].connect(
      new Wallet(ANVIL_KEY).connect(providerFor(CHAIN_NAME_2)),
    );
    await (
      await anvil2Dfr.enrollRemoteRouters(
        [unknownDomain],
        [addressToBytes32(Wallet.createRandom().address)],
      )
    ).wait();
    expect((await anvil2Dfr.domains()).map(Number)).to.have.members([
      domainOf(CHAIN_NAME_3),
      unknownDomain,
    ]);

    const driftedCheck = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(driftedCheck.exitCode).to.not.equal(0);

    await hyperlaneWarpApply(WARP_ID);
    expect((await anvil2Dfr.domains()).map(Number)).to.deep.equal([
      domainOf(CHAIN_NAME_3),
    ]);
    expect(await anvil2Dfr.routers(unknownDomain)).to.equal(
      ethers.constants.HashZero,
    );

    const convergedCheck = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(convergedCheck.exitCode).to.equal(0);
    expect(convergedCheck.text()).to.include('No violations found');
  });

  it('round-trips a delayed-flow hybrid nested in an aggregation hook', async () => {
    await deployPlainRoute();

    const nestedDelayedFlow: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: nestedDelayedFlowHookConfig(),
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: nestedDelayedFlowHookConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, nestedDelayedFlow);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    await hyperlaneWarpApply(WARP_ID);

    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    const secondApply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
    }).nothrow();
    expect(secondApply.exitCode).to.equal(0);
    expect(secondApply.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });
});
