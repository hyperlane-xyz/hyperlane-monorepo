import { expect } from 'chai';
import { ethers, Wallet } from 'ethers';

import {
  type MailboxClient,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainMap,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { hyperlaneRelayer, stopRelayer } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

import {
  countQueuedMessages,
  expectMessageDelivered,
  waitForQueuedMessage,
} from './delayedFlowHelpers.js';

import {
  domainOf,
  MAX_DELAY_SECONDS,
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
    readTokensByChain,
    expectMutualEnrollment,
    addressesByChain,
    plainRouteConfig,
    deployPlainRoute,
  } = setupDelayedFlowTest();

  it('removes each delayed-flow ISM before its hook', async () => {
    await deployPlainRoute();

    const delayedFlowConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        ...plainRouteConfig()[CHAIN_NAME_2],
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: delayedFlowHookConfig(),
      },
      [CHAIN_NAME_3]: {
        ...plainRouteConfig()[CHAIN_NAME_3],
        interchainSecurityModule: delayedFlowIsmConfig(),
        hook: delayedFlowHookConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, delayedFlowConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });
    await hyperlaneWarpApply(WARP_ID);

    const tokens = readTokensByChain();
    const clients: ChainMap<MailboxClient> = {};
    const fromBlocks: ChainMap<number> = {};
    for (const chain of ROUTE_CHAINS) {
      const provider = providerFor(chain);
      clients[chain] = MailboxClient__factory.connect(tokens[chain], provider);
      fromBlocks[chain] = (await provider.getBlockNumber()) + 1;
    }

    writeYamlOrJson(WARP_DEPLOY_PATH, plainRouteConfig());
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });
    await hyperlaneWarpApply(WARP_ID);

    for (const chain of ROUTE_CHAINS) {
      const [ismEvents, hookEvents] = await Promise.all([
        clients[chain].queryFilter(
          clients[chain].filters.IsmSet(),
          fromBlocks[chain],
        ),
        clients[chain].queryFilter(
          clients[chain].filters.HookSet(),
          fromBlocks[chain],
        ),
      ]);
      expect(ismEvents).to.have.length(1);
      expect(hookEvents).to.have.length(1);
      expect(ismEvents[0].blockNumber).to.be.lessThan(
        hookEvents[0].blockNumber,
      );
      expect(await clients[chain].interchainSecurityModule()).to.equal(
        ethers.constants.AddressZero,
      );
      expect(await clients[chain].hook()).to.equal(
        ethers.constants.AddressZero,
      );
    }

    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    const transfer = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpRouteId: WARP_ID,
    }).nothrow();
    expect(transfer.exitCode).to.equal(0);
  });

  it('replaces read-derived remoteIsms with the newly deployed in-route peers', async () => {
    await deployPlainRoute();

    const initialConfig: WarpRouteDeployConfig = {
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
    writeYamlOrJson(WARP_DEPLOY_PATH, initialConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });
    await hyperlaneWarpApply(WARP_ID);

    const initialDfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const replacementMaxDelay = MAX_DELAY_SECONDS + 1;
    const externalRemoteIsm = addressToBytes32(
      Wallet.createRandom().address,
    ).toLowerCase();
    const replacementConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        ...initialConfig[CHAIN_NAME_2],
        interchainSecurityModule: delayedFlowIsmConfig({
          maxDelay: replacementMaxDelay,
          remoteIsms: {
            [CHAIN_NAME_3]: addressToBytes32(
              initialDfrByChain[CHAIN_NAME_3].address,
            ),
            [CHAIN_NAME_4]: externalRemoteIsm,
          },
        }),
        hook: delayedFlowHookConfig({
          maxDelay: replacementMaxDelay,
          remoteIsms: {
            [CHAIN_NAME_3]: addressToBytes32(
              initialDfrByChain[CHAIN_NAME_3].address,
            ),
            [CHAIN_NAME_4]: externalRemoteIsm,
          },
        }),
      },
      [CHAIN_NAME_3]: {
        ...initialConfig[CHAIN_NAME_3],
        interchainSecurityModule: delayedFlowIsmConfig({
          maxDelay: replacementMaxDelay,
          remoteIsms: {
            [CHAIN_NAME_2]: addressToBytes32(
              initialDfrByChain[CHAIN_NAME_2].address,
            ),
          },
        }),
        hook: delayedFlowHookConfig({
          maxDelay: replacementMaxDelay,
          remoteIsms: {
            [CHAIN_NAME_2]: addressToBytes32(
              initialDfrByChain[CHAIN_NAME_2].address,
            ),
          },
        }),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, replacementConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });
    await hyperlaneWarpApply(WARP_ID);

    const replacementDfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    for (const chain of [CHAIN_NAME_2, CHAIN_NAME_3]) {
      expect(replacementDfrByChain[chain].address).to.not.equal(
        initialDfrByChain[chain].address,
      );
    }
    expect(
      await replacementDfrByChain[CHAIN_NAME_2].routers(domainOf(CHAIN_NAME_4)),
      'configured external peer should be retained',
    ).to.equal(externalRemoteIsm);

    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    const relayer = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3]);
    try {
      const queuedBefore = await countQueuedMessages(
        replacementDfrByChain[CHAIN_NAME_3],
      );
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: WARP_ID,
        relay: false,
      });
      const queuedId = await waitForQueuedMessage(
        replacementDfrByChain[CHAIN_NAME_3],
        queuedBefore,
      );
      await expectMessageDelivered(
        providerFor(CHAIN_NAME_3),
        addressesByChain[CHAIN_NAME_3].mailbox,
        queuedId,
      );
    } finally {
      await stopRelayer(relayer);
    }
  });
});
