import { expect } from 'chai';
import { Wallet, ethers, providers } from 'ethers';

import {
  type DelayedFlowRouterHookIsm,
  DelayedFlowRouterHookIsm__factory,
  type MailboxClient,
  Mailbox__factory,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type CallData,
  type ChainMap,
  type ChainMetadata,
  type HookConfig,
  HookType,
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
} from '../../../submitters/types.js';

import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  hyperlaneRelayer,
  hyperlaneSendMessage,
  stopRelayer,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
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

const SYMBOL = 'DFRAPPLY';
const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;
const WARP_DEPLOY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-config.yaml`;
const FILE_STRATEGY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-strategy.yaml`;
const FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-batch.json`;
const ROUTE_CHAINS = [CHAIN_NAME_2, CHAIN_NAME_3];

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

function providerFor(chain: string): providers.JsonRpcProvider {
  const { rpcUrls } = metadataFor(chain);
  assert(rpcUrls.length > 0, `No rpcUrls in the metadata fixture for ${chain}`);
  return new providers.JsonRpcProvider(rpcUrls[0].http);
}

function domainOf(chain: string): number {
  const { domainId, chainId } = metadataFor(chain);
  return domainId ?? Number(chainId);
}

// See warp-delayed-flow.e2e-test.ts: the first inbound transfer to a synthetic
// leg hits the empty-bucket clamp, so keep the cap small enough that the
// relayer's retry loop rides it out quickly.
const MAX_DELAY_SECONDS = 5;

describe('hyperlane warp apply with DelayedFlowRouterHookIsm e2e tests', async function () {
  this.timeout(5 * DEFAULT_E2E_TEST_TIMEOUT);

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
