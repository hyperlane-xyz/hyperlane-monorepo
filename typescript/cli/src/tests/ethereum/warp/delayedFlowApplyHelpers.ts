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
  type HookConfig,
  HookType,
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneSendMessage } from '../commands/helpers.js';
import { hyperlaneWarpDeploy } from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

import { connectDelayedFlowIsm } from './delayedFlowHelpers.js';

export const SYMBOL = 'DFRAPPLY';
export const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
export const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;
export const WARP_DEPLOY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-config.yaml`;
export const FILE_STRATEGY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-strategy.yaml`;
export const FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-batch.json`;
export const ROUTE_CHAINS = [CHAIN_NAME_2, CHAIN_NAME_3];

const METADATA_BY_CHAIN: Record<string, ChainMetadata> = {
  [CHAIN_NAME_2]: readYamlOrJson(CHAIN_2_METADATA_PATH),
  [CHAIN_NAME_3]: readYamlOrJson(CHAIN_3_METADATA_PATH),
  [CHAIN_NAME_4]: readYamlOrJson(CHAIN_4_METADATA_PATH),
};

function metadataFor(chain: string): ChainMetadata {
  const metadata = METADATA_BY_CHAIN[chain];
  assert(metadata, `No metadata fixture loaded for ${chain}`);
  return metadata;
}

export function providerFor(chain: string): providers.JsonRpcProvider {
  const { rpcUrls } = metadataFor(chain);
  assert(rpcUrls.length > 0, `No rpcUrls in the metadata fixture for ${chain}`);
  return new providers.JsonRpcProvider(rpcUrls[0].http);
}

export function domainOf(chain: string): number {
  const { domainId, chainId } = metadataFor(chain);
  return domainId ?? Number(chainId);
}

// See warp-delayed-flow.e2e-test.ts: the first inbound transfer to a synthetic
// leg hits the empty-bucket clamp, so keep the cap small enough that the
// relayer's retry loop rides it out quickly.
export const MAX_DELAY_SECONDS = 5;

export function setupDelayedFlowTest() {
  const deployerAddress = new Wallet(ANVIL_KEY).address;

  // The DFR authenticates flow only (moduleType NULL), so its docstring
  // mandates composing it under an authenticating ISM.
  function delayedFlowIsmConfig({
    maxDelay = MAX_DELAY_SECONDS,
    remoteIsms,
  }: {
    maxDelay?: number;
    remoteIsms?: Record<string, string>;
  } = {}): WarpRouteDeployConfig[string]['interchainSecurityModule'] {
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
          maxDelay,
          duration: 86400n,
          owner: deployerAddress,
          remoteIsms,
        },
      ],
    };
  }

  function delayedFlowHookConfig({
    maxDelay = MAX_DELAY_SECONDS,
    remoteIsms,
  }: {
    maxDelay?: number;
    remoteIsms?: Record<string, string>;
  } = {}): HookConfig {
    return {
      type: HookType.DELAYED_FLOW_ROUTER,
      thresholdBps: 10000,
      maxDelay,
      duration: 86400n,
      owner: deployerAddress,
      remoteIsms,
    };
  }

  function nestedDelayedFlowHookConfig(): HookConfig {
    return {
      type: HookType.AGGREGATION,
      hooks: [delayedFlowHookConfig(), { type: HookType.MERKLE_TREE }],
    };
  }

  function readTokensByChain(): Record<string, Address> {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    return Object.fromEntries(
      warpCoreConfig.tokens.map((token) => {
        assert(
          token.addressOrDenom,
          `Missing address for ${token.chainName} token`,
        );
        return [token.chainName, token.addressOrDenom];
      }),
    );
  }

  async function expectMutualEnrollment(chains: string[]) {
    const tokens = readTokensByChain();
    const dfrByChain: Record<string, DelayedFlowRouterHookIsm> = {};
    for (const chain of chains) {
      dfrByChain[chain] = await connectDelayedFlowIsm(
        providerFor(chain),
        tokens[chain],
      );
      expect((await dfrByChain[chain].warpRouter()).toLowerCase()).to.equal(
        tokens[chain].toLowerCase(),
      );
    }

    for (const chain of chains) {
      for (const remote of chains) {
        if (chain === remote) continue;
        expect(
          await dfrByChain[chain].routers(domainOf(remote)),
          `${chain} should enroll ${remote}`,
        ).to.equal(addressToBytes32(dfrByChain[remote].address).toLowerCase());
      }
    }
    return dfrByChain;
  }

  const addressesByChain: Record<string, ChainAddresses> = {};

  before(async () => {
    const [chain2Addresses, chain3Addresses, chain4Addresses] =
      await Promise.all([
        deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
      ]);
    addressesByChain[CHAIN_NAME_2] = chain2Addresses;
    addressesByChain[CHAIN_NAME_3] = chain3Addresses;
    addressesByChain[CHAIN_NAME_4] = chain4Addresses;

    // The DFR credit replay guard (`nonce <= lastCreditedNonce`, initialized
    // to 0) can never credit a mailbox-nonce-0 message, so bump every mailbox
    // past nonce 0 before any warp dispatch. The SDK refuses to apply a
    // delayed-flow ISM onto a nonce-0 mailbox, so this priming is what makes
    // the applies below legal — the assertion pins that rather than leaving
    // the dependency implicit.
    await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_3, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_3, CHAIN_NAME_2, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_4, CHAIN_NAME_2, { quick: true });

    for (const chain of [CHAIN_NAME_2, CHAIN_NAME_3, CHAIN_NAME_4]) {
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

  // The shared e2e setup wipes deployments/warp_routes before EVERY test, so
  // the route has to be deployed inside the test that uses it.
  function plainRouteConfig(): WarpRouteDeployConfig {
    return {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: deployerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: deployerAddress,
      },
    };
  }

  async function deployPlainRoute() {
    writeYamlOrJson(WARP_DEPLOY_PATH, plainRouteConfig());
    await hyperlaneWarpDeploy(WARP_DEPLOY_PATH, WARP_ID);
  }

  return {
    deployerAddress,
    delayedFlowIsmConfig,
    delayedFlowHookConfig,
    nestedDelayedFlowHookConfig,
    readTokensByChain,
    expectMutualEnrollment,
    addressesByChain,
    plainRouteConfig,
    deployPlainRoute,
  };
}
