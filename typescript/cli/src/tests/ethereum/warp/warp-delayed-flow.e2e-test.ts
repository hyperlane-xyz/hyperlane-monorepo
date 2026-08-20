import { expect } from 'chai';
import { Wallet, providers } from 'ethers';

import {
  type DelayedFlowRouterHookIsm,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HookType,
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  hyperlaneRelayer,
  hyperlaneSendMessage,
  stopRelayer,
} from '../commands/helpers.js';
import {
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

import {
  connectDelayedFlowIsm,
  countQueuedMessages,
  expectMessageDelivered,
  waitForQueuedMessage,
} from './delayedFlowHelpers.js';

const SYMBOL = 'DFR';
const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;

const METADATA_BY_CHAIN: Record<string, ChainMetadata> = {
  [CHAIN_NAME_2]: readYamlOrJson(CHAIN_2_METADATA_PATH),
  [CHAIN_NAME_3]: readYamlOrJson(CHAIN_3_METADATA_PATH),
};

function metadataFor(chain: string): ChainMetadata {
  const metadata = METADATA_BY_CHAIN[chain];
  assert(metadata, `No metadata fixture loaded for ${chain}`);
  return metadata;
}

function providerFor(chain: string): providers.JsonRpcProvider {
  const { rpcUrls } = metadataFor(chain);
  assert(rpcUrls.length > 0, `No rpcUrls in the metadata fixture for ${chain}`);
  return new providers.JsonRpcProvider(rpcUrls[0].http);
}

function domainOf(chain: string): number {
  const { domainId, chainId } = metadataFor(chain);
  return domainId ?? Number(chainId);
}

// Small cap on any single message's delay: the first inbound transfer to the
// synthetic leg necessarily hits the empty-bucket clamp (TVL = totalSupply = 0
// before the first mint), so it waits exactly this many seconds while the
// relayer retries `MessageNotReadyUntil` reverts.
const MAX_DELAY_SECONDS = 5;

describe('hyperlane warp deploy with DelayedFlowRouterHookIsm e2e tests', async function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  const deployerAddress = new Wallet(ANVIL_KEY).address;
  const addressesByChain: Record<string, ChainAddresses> = {};

  // The DelayedFlowRouterHookIsm authenticates flow only (moduleType NULL);
  // its docstring mandates composing it under an authenticating ISM, so the
  // production shape is an aggregation with threshold 2.
  function delayedFlowIsmConfig(): WarpRouteDeployConfig[string]['interchainSecurityModule'] {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        {
          type: IsmType.TRUSTED_RELAYER,
          relayer: deployerAddress,
        },
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          thresholdBps: 10000,
          maxDelay: MAX_DELAY_SECONDS,
          duration: 86400n,
          owner: deployerAddress,
        },
      ],
    };
  }

  function delayedFlowHookConfig(): WarpRouteDeployConfig[string]['hook'] {
    return {
      type: HookType.DELAYED_FLOW_ROUTER,
      thresholdBps: 10000,
      maxDelay: MAX_DELAY_SECONDS,
      duration: 86400n,
      owner: deployerAddress,
    };
  }

  before(async () => {
    const [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
    addressesByChain[CHAIN_NAME_2] = chain2Addresses;
    addressesByChain[CHAIN_NAME_3] = chain3Addresses;

    // Bump both mailboxes past nonce 0: DelayedFlowRouterHookIsm's credit
    // replay guard (`nonce <= lastCreditedNonce`, initialized to 0) can never
    // credit a mailbox-nonce-0 message, so the first-ever dispatch on a fresh
    // chain would revert AlreadyCredited(0) inside postDispatch. The SDK
    // refuses to deploy a delayed-flow route onto a nonce-0 mailbox, so this
    // priming is what makes the deploy below legal — the assertion pins that
    // rather than leaving the dependency implicit.
    await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_3, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_3, CHAIN_NAME_2, { quick: true });

    for (const chain of [CHAIN_NAME_2, CHAIN_NAME_3]) {
      const nonce = await Mailbox__factory.connect(
        addressesByChain[chain].mailbox,
        providerFor(chain),
      ).nonce();
      expect(
        nonce,
        `${chain} mailbox must be primed past nonce 0`,
      ).to.be.greaterThan(0);
    }
  });

  it('deploys, converges on warp check, and delivers transfers in both directions', async () => {
    const warpConfig: WarpRouteDeployConfig = {
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
    const warpConfigPath = `${TEMP_PATH}/warp-route-delayed-flow-config.yaml`;
    writeYamlOrJson(warpConfigPath, warpConfig);

    await hyperlaneWarpDeploy(warpConfigPath, WARP_ID);

    // the deployed route must converge: no diffs against the same config
    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    // resolve the deployed tokens and their DelayedFlowRouterHookIsm instances
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    const tokenByChain = Object.fromEntries(
      warpCoreConfig.tokens.map((token) => {
        assert(
          token.addressOrDenom,
          `Missing address for ${token.chainName} token`,
        );
        return [token.chainName, token.addressOrDenom];
      }),
    );
    const dfrByChain: Record<string, DelayedFlowRouterHookIsm> = {};
    for (const chain of [CHAIN_NAME_2, CHAIN_NAME_3]) {
      dfrByChain[chain] = await connectDelayedFlowIsm(
        providerFor(chain),
        tokenByChain[chain],
      );
    }

    // both instances are paired with their router and mutually enrolled
    for (const [chain, remote] of [
      [CHAIN_NAME_2, CHAIN_NAME_3],
      [CHAIN_NAME_3, CHAIN_NAME_2],
    ]) {
      expect((await dfrByChain[chain].warpRouter()).toLowerCase()).to.equal(
        tokenByChain[chain].toLowerCase(),
      );
      expect(
        await dfrByChain[chain].routers(domainOf(remote)),
        `${chain} should enroll ${remote}`,
      ).to.equal(addressToBytes32(dfrByChain[remote].address).toLowerCase());
    }

    // Route-scoped relaying must include both token-router messages and the
    // DFR-to-DFR preverification messages they dispatch.
    const relayer = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3], WARP_ID);
    try {
      const queuedOnChain3Before = await countQueuedMessages(
        dfrByChain[CHAIN_NAME_3],
      );
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: WARP_ID,
        relay: false,
      });

      // the DFR engaged: the destination instance preverified the transfer
      // (readyAt committed via MessageQueued) before the mailbox delivered it
      const queuedOnChain3 = await waitForQueuedMessage(
        dfrByChain[CHAIN_NAME_3],
        queuedOnChain3Before,
      );
      // the origin instance credited its bucket on dispatch
      expect(
        await dfrByChain[CHAIN_NAME_2].lastCreditedNonce(),
      ).to.be.greaterThan(0);
      await expectMessageDelivered(
        providerFor(CHAIN_NAME_3),
        addressesByChain[CHAIN_NAME_3].mailbox,
        queuedOnChain3,
      );

      const queuedOnChain2Before = await countQueuedMessages(
        dfrByChain[CHAIN_NAME_2],
      );
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_3,
        destination: CHAIN_NAME_2,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const queuedOnChain2 = await waitForQueuedMessage(
        dfrByChain[CHAIN_NAME_2],
        queuedOnChain2Before,
      );
      expect(
        await dfrByChain[CHAIN_NAME_3].lastCreditedNonce(),
      ).to.be.greaterThan(0);
      await expectMessageDelivered(
        providerFor(CHAIN_NAME_2),
        addressesByChain[CHAIN_NAME_2].mailbox,
        queuedOnChain2,
      );
    } finally {
      await stopRelayer(relayer);
    }
  });
});
