import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  ERC20__factory,
  IPostDispatchHook__factory,
  LayerZeroV2HookIsm__factory,
  Mailbox__factory,
  MailboxClient__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroUln302__factory,
  ProxyAdmin__factory,
  StaticAggregationHook__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  EvmLayerZeroV2HookIsmReader,
  HookType,
  IsmType,
  LayerZeroV2ConfigMode,
  OnchainHookType,
  TokenType,
  WarpRouteDeployConfigSchema,
  WormholeConsistencyType,
  proxyAdmin,
} from '@hyperlane-xyz/sdk';
import type {
  HookConfig,
  IsmConfig,
  LayerZeroV2IsmConfig,
  MultiProvider,
  WarpRouteDeployConfigMailboxRequired,
  WormholeIsmConfig,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  getDeployedWarpAddress,
  hyperlaneStatus,
  startCcipServer,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  EXAMPLES_PATH,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';
import {
  WH_CHAIN_ID_2,
  WH_CHAIN_ID_3,
  type WormholeChainFixture,
  deployWormholeMocks,
  readPublications,
  signPublicationVaa,
  startVaaUpstream,
  wormholeServiceEnv,
} from '../wormhole/fixtures.js';

const PACKET_SERVICE_PORT = 3_803;
const COMBINED_SERVICE_PORT = 3_804;
// Anvil account #1: distinct from the deployer, which keeps the warp route.
const LAYERZERO_ROUTER_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LAYERZERO_WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/layerzero/layerzero-warp-route.yaml`;

interface ExampleChainConfig {
  hook: HookConfig;
  interchainSecurityModule: LayerZeroV2IsmConfig;
  pathway: LayerZeroV2IsmConfig['pathways'][string];
}

/** Reads the published example through the same schema `warp deploy` uses. */
function readExampleChainConfigs(): ExampleChainConfig[] {
  const example = WarpRouteDeployConfigSchema.parse(
    readYamlOrJson(LAYERZERO_WARP_CONFIG_PATH_EXAMPLE),
  );
  return Object.entries(example).map(([chain, config]) => {
    const { hook, interchainSecurityModule } = config;
    assert(hook, `Example ${chain} config is missing its hook`);
    assert(
      typeof interchainSecurityModule === 'object' &&
        interchainSecurityModule.type === IsmType.LAYER_ZERO_V2,
      `Example ${chain} config must use a ${IsmType.LAYER_ZERO_V2}`,
    );
    const pathways = Object.values(interchainSecurityModule.pathways);
    assert(
      pathways.length === 1,
      `Example ${chain} config must have exactly one pathway`,
    );
    const [pathway] = pathways;
    return { hook, interchainSecurityModule, pathway };
  });
}

interface LayerZeroMocks {
  endpoint: Address;
  sendLibrary: Address;
  receiveLibrary: Address;
}

describe('warp deploy with LayerZero V2 combined hook/ISM', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);
  const chains = [CHAIN_NAME_2, CHAIN_NAME_3];
  const extendedChains = [...chains, CHAIN_NAME_4];
  const eids: Record<string, number> = {
    [CHAIN_NAME_2]: 40_101,
    [CHAIN_NAME_3]: 40_102,
    [CHAIN_NAME_4]: 40_103,
  };
  let mailboxes: Record<string, Address>;
  let endpoints: Record<string, Address>;
  let sendLibraries: Record<string, Address>;
  let receiveLibraries: Record<string, Address>;

  async function getMultiProvider(): Promise<MultiProvider> {
    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    return multiProvider;
  }

  async function deployLayerZeroMocks(
    multiProvider: MultiProvider,
    chain: string,
  ): Promise<LayerZeroMocks> {
    multiProvider.setSigner(
      chain,
      new ethers.Wallet(ANVIL_KEY, multiProvider.getProvider(chain)),
    );
    const endpoint = await multiProvider.handleDeploy(
      chain,
      new MockLayerZeroEndpointV2__factory(),
      [eids[chain]],
    );
    const sendLibrary = await multiProvider.handleDeploy(
      chain,
      new MockLayerZeroUln302__factory(),
      [endpoint.address],
    );
    const receiveLibrary = await multiProvider.handleDeploy(
      chain,
      new MockLayerZeroUln302__factory(),
      [endpoint.address],
    );
    await multiProvider.handleTx(
      chain,
      endpoint
        .connect(multiProvider.getSigner(chain))
        .registerMockLibrary(sendLibrary.address),
    );
    await multiProvider.handleTx(
      chain,
      endpoint
        .connect(multiProvider.getSigner(chain))
        .registerMockLibrary(receiveLibrary.address),
    );
    return {
      endpoint: endpoint.address,
      sendLibrary: sendLibrary.address,
      receiveLibrary: receiveLibrary.address,
    };
  }

  before(async () => {
    const cores = await Promise.all(
      extendedChains.map((chain) =>
        deployOrUseExistingCore(chain, CORE_CONFIG_PATH, ANVIL_KEY),
      ),
    );
    mailboxes = Object.fromEntries(
      extendedChains.map((chain, index) => [chain, cores[index].mailbox]),
    );
    const multiProvider = await getMultiProvider();
    endpoints = {};
    sendLibraries = {};
    receiveLibraries = {};
    for (const chain of extendedChains) {
      const mocks = await deployLayerZeroMocks(multiProvider, chain);
      endpoints[chain] = mocks.endpoint;
      sendLibraries[chain] = mocks.sendLibrary;
      receiveLibraries[chain] = mocks.receiveLibrary;
    }
  });

  function layerZeroIsm(
    chain: string,
    remotes: string[],
    urls: string[],
    example: ExampleChainConfig,
  ): LayerZeroV2IsmConfig {
    return {
      type: example.interchainSecurityModule.type,
      owner: ANVIL_DEPLOYER_ADDRESS,
      endpoint: endpoints[chain],
      layerZeroDomainId: eids[chain],
      urls,
      pathways: Object.fromEntries(
        remotes.map((remote) => [
          remote,
          {
            layerZeroDomainId: eids[remote],
            sendLibrary: sendLibraries[chain],
            receiveLibrary: receiveLibraries[chain],
            sendConfig: example.pathway.sendConfig,
            receiveConfig: example.pathway.receiveConfig,
          },
        ]),
      ),
    };
  }

  /**
   * Builds the route from the published example, pointing each leg at the
   * local Mailbox and mock LayerZero Endpoint and libraries. Chains beyond the
   * example's legs reuse its first leg.
   */
  function configFor(
    symbol: string,
    {
      routeChains = chains,
      urls,
      wrapIsm = (ism) => ism,
    }: {
      routeChains?: string[];
      urls?: string[];
      wrapIsm?: (ism: LayerZeroV2IsmConfig) => IsmConfig;
    } = {},
  ): WarpRouteDeployConfigMailboxRequired {
    const examples = readExampleChainConfigs();
    assert(
      examples.length === chains.length,
      `Expected ${chains.length} chains in ${LAYERZERO_WARP_CONFIG_PATH_EXAMPLE}`,
    );
    const configs: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of routeChains.entries()) {
      const example = index < examples.length ? examples[index] : examples[0];
      const remotes = routeChains.filter((remote) => remote !== chain);
      configs[chain] = {
        type: index === 0 ? TokenType.native : TokenType.synthetic,
        owner: ANVIL_DEPLOYER_ADDRESS,
        mailbox: mailboxes[chain],
        name: `${symbol} token`,
        symbol,
        decimals: 18,
        hook: example.hook,
        interchainSecurityModule: wrapIsm(
          layerZeroIsm(
            chain,
            remotes,
            urls ?? example.interchainSecurityModule.urls,
            example,
          ),
        ),
      };
    }
    return configs;
  }

  function layerZeroIsmOf(
    config: WarpRouteDeployConfigMailboxRequired,
    chain: string,
  ): LayerZeroV2IsmConfig {
    const ism = config[chain].interchainSecurityModule;
    assert(
      typeof ism !== 'string' && ism?.type === IsmType.LAYER_ZERO_V2,
      `Missing LayerZero ISM on ${chain}`,
    );
    return ism;
  }

  async function installedLayerZeroRouters(
    warpCorePath: string,
    routeChains: string[],
  ): Promise<Record<string, Address>> {
    const multiProvider = await getMultiProvider();
    const routers: Record<string, Address> = {};
    for (const chain of routeChains) {
      routers[chain] = await MailboxClient__factory.connect(
        getDeployedWarpAddress(chain, warpCorePath),
        multiProvider.getProvider(chain),
      ).interchainSecurityModule();
    }
    return routers;
  }

  function orderedDvns(chain: string): Address[] {
    return [sendLibraries[chain], receiveLibraries[chain]].toSorted((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  it('deploys, applies and checks the mesh', async () => {
    const symbol = 'LZCR';
    const configPath = `${TEMP_PATH}/layerzero-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    writeYamlOrJson(configPath, configFor(symbol));

    const result = await hyperlaneWarpDeploy(configPath, routeId);
    expect(result.exitCode).to.equal(0);

    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    const combined: Record<string, Address> = {};
    for (const chain of chains) {
      const warpRouter = getDeployedWarpAddress(chain, warpCorePath);
      const client = MailboxClient__factory.connect(
        warpRouter,
        multiProvider.getProvider(chain),
      );
      const [hook, ism] = await Promise.all([
        client.hook(),
        client.interchainSecurityModule(),
      ]);
      combined[chain] = ism;
      const children = await StaticAggregationHook__factory.connect(
        hook,
        multiProvider.getProvider(chain),
      ).hooks('0x');
      expect(children.map((child) => child.toLowerCase())).to.include(
        ism.toLowerCase(),
      );
    }
    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const derived = await new EvmLayerZeroV2HookIsmReader(
        multiProvider,
        chain,
      ).deriveLayerZeroConfig(combined[chain]);
      assert(derived.remoteRouters[remote], `Missing ${remote} route`);
      expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
        combined[remote].toLowerCase(),
      );
      expect(derived.remoteRouters[remote].sendConfig).to.deep.equal({
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      });
      expect(derived.remoteRouters[remote].receiveConfig).to.deep.equal({
        uln: { type: LayerZeroV2ConfigMode.Default },
      });
      expect(
        derived.remoteRouters[remote].effectiveSendConfig?.executor
          .maxMessageSize,
      ).to.equal(10_000);
    }
    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode).to.equal(0);

    const updatedConfig = configFor(symbol);
    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const requiredDVNs = orderedDvns(chain);
      const ism = layerZeroIsmOf(updatedConfig, chain);
      const pathway = ism.pathways[remote];
      assert(pathway, `Missing ${chain} -> ${remote} pathway`);
      pathway.sendConfig = {
        executor: {
          type: LayerZeroV2ConfigMode.Override,
          maxMessageSize: 20_000,
          executor: sendLibraries[chain],
        },
        uln: {
          type: LayerZeroV2ConfigMode.Override,
          confirmations: 15n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      };
      pathway.receiveConfig = {
        uln: {
          type: LayerZeroV2ConfigMode.Override,
          confirmations: 20n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      };
      ism.urls = [
        'http://127.0.0.1:3000/layerzero/getLayerZeroPacket',
        'http://127.0.0.1:3001/layerzero/getLayerZeroPacket',
      ];
    }
    const registryDeployPath = warpCorePath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(registryDeployPath, updatedConfig);
    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);

    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const requiredDVNs = orderedDvns(chain);
      const derived = await new EvmLayerZeroV2HookIsmReader(
        multiProvider,
        chain,
      ).deriveLayerZeroConfig(combined[chain]);
      expect(derived.urls).to.deep.equal([
        'http://127.0.0.1:3000/layerzero/getLayerZeroPacket',
        'http://127.0.0.1:3001/layerzero/getLayerZeroPacket',
      ]);
      expect(derived.remoteRouters[remote].sendConfig).to.deep.equal({
        executor: {
          type: LayerZeroV2ConfigMode.Override,
          maxMessageSize: 20_000,
          executor: sendLibraries[chain],
        },
        uln: {
          type: LayerZeroV2ConfigMode.Override,
          confirmations: 15n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
      expect(derived.remoteRouters[remote].receiveConfig).to.deep.equal({
        uln: {
          type: LayerZeroV2ConfigMode.Override,
          confirmations: 20n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
      expect(derived.remoteRouters[remote].effectiveSendConfig).to.deep.equal({
        executor: {
          maxMessageSize: 20_000,
          executor: sendLibraries[chain],
        },
        uln: {
          confirmations: 15n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
      expect(
        derived.remoteRouters[remote].effectiveReceiveConfig,
      ).to.deep.equal({
        uln: {
          confirmations: 20n,
          requiredDVNs,
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
    }
    const postApplyCheck = await hyperlaneWarpCheck(routeId);
    expect(postApplyCheck.exitCode).to.equal(0);

    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const ism = layerZeroIsmOf(updatedConfig, chain);
      const pathway = ism.pathways[remote];
      assert(pathway, `Missing ${chain} -> ${remote} pathway`);
      assert(
        pathway.sendConfig.uln.type === LayerZeroV2ConfigMode.Override &&
          pathway.receiveConfig.uln.type === LayerZeroV2ConfigMode.Override,
        `Missing LayerZero ULN overrides on ${chain}`,
      );
      const unorderedDvns = orderedDvns(chain).toReversed();
      pathway.sendConfig.uln.requiredDVNs = unorderedDvns;
      pathway.receiveConfig.uln.requiredDVNs = unorderedDvns;
    }
    writeYamlOrJson(registryDeployPath, updatedConfig);

    const unorderedCheck = await hyperlaneWarpCheck(routeId);
    expect(unorderedCheck.exitCode).to.equal(0);
    const unorderedApply = await hyperlaneWarpApply(routeId);
    expect(unorderedApply.exitCode).to.equal(0);
    expect(unorderedApply.stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );

    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const ism = layerZeroIsmOf(updatedConfig, chain);
      const pathway = ism.pathways[remote];
      assert(pathway, `Missing ${chain} -> ${remote} pathway`);
      pathway.sendConfig = {
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      };
      pathway.receiveConfig = {
        uln: { type: LayerZeroV2ConfigMode.Default },
      };
    }
    writeYamlOrJson(registryDeployPath, updatedConfig);

    const resetApply = await hyperlaneWarpApply(routeId);
    expect(resetApply.exitCode).to.equal(0);
    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const derived = await new EvmLayerZeroV2HookIsmReader(
        multiProvider,
        chain,
      ).deriveLayerZeroConfig(combined[chain]);
      expect(derived.remoteRouters[remote].sendConfig).to.deep.equal({
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      });
      expect(derived.remoteRouters[remote].receiveConfig).to.deep.equal({
        uln: { type: LayerZeroV2ConfigMode.Default },
      });
      expect(derived.remoteRouters[remote].effectiveSendConfig).to.deep.equal({
        executor: {
          maxMessageSize: 10_000,
          executor: sendLibraries[chain],
        },
        uln: {
          confirmations: 12n,
          requiredDVNs: [sendLibraries[chain]],
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
      expect(
        derived.remoteRouters[remote].effectiveReceiveConfig,
      ).to.deep.equal({
        uln: {
          confirmations: 12n,
          requiredDVNs: [receiveLibraries[chain]],
          optionalDVNs: [],
          optionalDVNThreshold: 0,
        },
      });
    }
    const postResetCheck = await hyperlaneWarpCheck(routeId);
    expect(postResetCheck.exitCode).to.equal(0);

    const idempotentApply = await hyperlaneWarpApply(routeId);
    expect(idempotentApply.exitCode).to.equal(0);
    expect(idempotentApply.stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('deploys and checks a mesh nested in an aggregation ISM', async () => {
    const symbol = 'LZAG';
    const configPath = `${TEMP_PATH}/layerzero-nested-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    writeYamlOrJson(
      configPath,
      configFor(symbol, {
        wrapIsm: (ism) => ({
          type: IsmType.AGGREGATION,
          threshold: 1,
          modules: [ism],
        }),
      }),
    );

    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);

    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    for (const chain of chains) {
      const client = MailboxClient__factory.connect(
        getDeployedWarpAddress(chain, warpCorePath),
        multiProvider.getProvider(chain),
      );
      const [hook, ism] = await Promise.all([
        client.hook(),
        client.interchainSecurityModule(),
      ]);
      const [modules] = await StaticAggregationIsm__factory.connect(
        ism,
        multiProvider.getProvider(chain),
      ).modulesAndThreshold('0x');
      const children = await StaticAggregationHook__factory.connect(
        hook,
        multiProvider.getProvider(chain),
      ).hooks('0x');
      expect(modules).to.have.length(1);
      expect(children.map((child) => child.toLowerCase())).to.include(
        modules[0].toLowerCase(),
      );
    }

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode, check.stdout).to.equal(0);
    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);
    expect(apply.stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('adds a CCIP-read mesh to a route with no hook or ISM', async () => {
    const symbol = 'LZAP';
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    const initialConfig = configFor(symbol);
    for (const config of Object.values(initialConfig)) {
      config.hook = ethers.constants.AddressZero;
      config.interchainSecurityModule = ethers.constants.AddressZero;
    }
    const configPath = `${TEMP_PATH}/layerzero-apply-warp.yaml`;
    writeYamlOrJson(configPath, initialConfig);

    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);

    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    const desiredConfig = configFor(symbol);
    writeYamlOrJson(
      warpCorePath.replace('-config.yaml', '-deploy.yaml'),
      desiredConfig,
    );

    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);

    for (const chain of chains) {
      const warpRouter = getDeployedWarpAddress(chain, warpCorePath);
      const client = MailboxClient__factory.connect(
        warpRouter,
        multiProvider.getProvider(chain),
      );
      const [hook, ism] = await Promise.all([
        client.hook(),
        client.interchainSecurityModule(),
      ]);
      expect(hook).not.to.equal(ethers.constants.AddressZero);
      expect(ism).not.to.equal(ethers.constants.AddressZero);
      const children = await StaticAggregationHook__factory.connect(
        hook,
        multiProvider.getProvider(chain),
      ).hooks('0x');
      expect(children.map((child) => child.toLowerCase())).to.include(
        ism.toLowerCase(),
      );
    }

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode).to.equal(0);
  });

  it('redeploys the chain whose immutable endpoint changes through warp apply', async () => {
    const symbol = 'LZIM';
    const configPath = `${TEMP_PATH}/layerzero-immutable-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    const [changed, kept] = chains;
    writeYamlOrJson(configPath, configFor(symbol));
    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);
    const previous = await installedLayerZeroRouters(warpCorePath, chains);

    const multiProvider = await getMultiProvider();
    const replacement = await deployLayerZeroMocks(multiProvider, changed);
    const config = configFor(symbol);
    const ism = layerZeroIsmOf(config, changed);
    const pathway = ism.pathways[kept];
    assert(pathway, `Missing ${changed} -> ${kept} pathway`);
    ism.endpoint = replacement.endpoint;
    pathway.sendLibrary = replacement.sendLibrary;
    pathway.receiveLibrary = replacement.receiveLibrary;
    writeYamlOrJson(
      warpCorePath.replace('-config.yaml', '-deploy.yaml'),
      config,
    );
    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);

    const routers = await installedLayerZeroRouters(warpCorePath, chains);
    expect(routers[changed]).not.to.equal(previous[changed]);
    expect(routers[kept]).to.equal(previous[kept]);
    const client = MailboxClient__factory.connect(
      getDeployedWarpAddress(changed, warpCorePath),
      multiProvider.getProvider(changed),
    );
    const children = await StaticAggregationHook__factory.connect(
      await client.hook(),
      multiProvider.getProvider(changed),
    ).hooks('0x');
    expect(children.map((child) => child.toLowerCase())).to.include(
      routers[changed].toLowerCase(),
    );
    const replaced = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      changed,
    ).deriveLayerZeroConfig(routers[changed]);
    expect(replaced.endpoint).to.equal(replacement.endpoint);
    expect(replaced.remoteRouters[kept].router.toLowerCase()).to.equal(
      routers[kept].toLowerCase(),
    );
    expect(replaced.remoteRouters[kept].sendLibrary).to.equal(
      replacement.sendLibrary,
    );
    const reused = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      kept,
    ).deriveLayerZeroConfig(routers[kept]);
    expect(reused.remoteRouters[changed].router.toLowerCase()).to.equal(
      routers[changed].toLowerCase(),
    );
    expect(reused.remoteRouters[changed].layerZeroDomainId).to.equal(
      eids[changed],
    );

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode).to.equal(0);
    const idempotentApply = await hyperlaneWarpApply(routeId);
    expect(idempotentApply.exitCode).to.equal(0);
    expect(idempotentApply.stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('extends the mesh to a third chain through warp apply', async () => {
    const symbol = 'LZEX';
    const configPath = `${TEMP_PATH}/layerzero-extend-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    writeYamlOrJson(configPath, configFor(symbol));
    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);
    const existing = await installedLayerZeroRouters(warpCorePath, chains);

    writeYamlOrJson(
      warpCorePath.replace('-config.yaml', '-deploy.yaml'),
      configFor(symbol, { routeChains: extendedChains }),
    );
    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);

    const routers = await installedLayerZeroRouters(
      warpCorePath,
      extendedChains,
    );
    for (const chain of chains) {
      expect(routers[chain]).to.equal(existing[chain]);
    }
    const multiProvider = await getMultiProvider();
    for (const chain of extendedChains) {
      const derived = await new EvmLayerZeroV2HookIsmReader(
        multiProvider,
        chain,
      ).deriveLayerZeroConfig(routers[chain]);
      const remotes = extendedChains.filter((remote) => remote !== chain);
      expect(Object.keys(derived.remoteRouters)).to.have.members(remotes);
      for (const remote of remotes) {
        expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
          routers[remote].toLowerCase(),
        );
        expect(derived.remoteRouters[remote].layerZeroDomainId).to.equal(
          eids[remote],
        );
      }
    }

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode).to.equal(0);
  });

  it('hands only the LayerZero routers to a non-deployer owner on deploy', async () => {
    const symbol = 'LZOW';
    const configPath = `${TEMP_PATH}/layerzero-owner-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    const config = configFor(symbol, {
      wrapIsm: (ism) => ({
        type: ism.type,
        owner: LAYERZERO_ROUTER_OWNER,
        endpoint: ism.endpoint,
        layerZeroDomainId: ism.layerZeroDomainId,
        pathways: ism.pathways,
        urls: ism.urls,
      }),
    });
    writeYamlOrJson(configPath, config);

    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);

    const multiProvider = await getMultiProvider();
    const routers = await installedLayerZeroRouters(warpCorePath, chains);
    for (const chain of chains) {
      const provider = multiProvider.getProvider(chain);
      const warpRouter = getDeployedWarpAddress(chain, warpCorePath);
      const client = MailboxClient__factory.connect(warpRouter, provider);
      expect(await client.owner()).to.equal(ANVIL_DEPLOYER_ADDRESS);
      expect(
        await ProxyAdmin__factory.connect(
          await proxyAdmin(provider, warpRouter),
          provider,
        ).owner(),
      ).to.equal(ANVIL_DEPLOYER_ADDRESS);

      expect(
        await LayerZeroV2HookIsm__factory.connect(
          routers[chain],
          provider,
        ).owner(),
      ).to.equal(LAYERZERO_ROUTER_OWNER);
      const children = await StaticAggregationHook__factory.connect(
        await client.hook(),
        provider,
      ).hooks('0x');
      expect(children).to.have.length(2);
      expect(children.map((child) => child.toLowerCase())).to.include(
        routers[chain].toLowerCase(),
      );

      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const derived = await new EvmLayerZeroV2HookIsmReader(
        multiProvider,
        chain,
      ).deriveLayerZeroConfig(routers[chain]);
      expect(Object.keys(derived.remoteRouters)).to.have.members([remote]);
      expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
        routers[remote].toLowerCase(),
      );
    }

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode, check.stdout).to.equal(0);
  });

  it('delivers a warp transfer over LayerZero through the packet service', async () => {
    const symbol = 'LZSD';
    const configPath = `${TEMP_PATH}/layerzero-send-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    const [origin, destination] = chains;
    writeYamlOrJson(
      configPath,
      configFor(symbol, {
        urls: [
          `http://127.0.0.1:${PACKET_SERVICE_PORT}/layerzero/getLayerZeroPacket`,
        ],
      }),
    );
    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);

    const service = await startCcipServer({
      port: PACKET_SERVICE_PORT,
      modules: ['layerzero'],
    });
    try {
      const multiProvider = await getMultiProvider();
      const syntheticToken = ERC20__factory.connect(
        getDeployedWarpAddress(destination, warpCorePath),
        multiProvider.getProvider(destination),
      );
      const balanceBefore = await syntheticToken.balanceOf(
        ANVIL_DEPLOYER_ADDRESS,
      );

      const send = await hyperlaneWarpSendRelay({
        origin,
        destination,
        warpRouteId: routeId,
        relay: false,
        value: 2,
        quick: true,
      });
      expect(send.exitCode).to.equal(0);

      const mailbox = Mailbox__factory.connect(
        mailboxes[origin],
        multiProvider.getProvider(origin),
      );
      const dispatched = await mailbox.queryFilter(
        mailbox.filters.Dispatch(getDeployedWarpAddress(origin, warpCorePath)),
      );
      expect(dispatched).to.have.length(1);
      const relayed = await hyperlaneStatus({
        origin,
        dispatchTx: dispatched[0].transactionHash,
        relay: true,
        key: ANVIL_KEY,
      }).nothrow();
      expect(
        relayed.exitCode,
        `self-relay failed:\n${relayed.stdout}\n${relayed.stderr}`,
      ).to.equal(0);

      const balanceAfter = await syntheticToken.balanceOf(
        ANVIL_DEPLOYER_ADDRESS,
      );
      expect(balanceAfter.sub(balanceBefore).toString()).to.equal('2');
    } finally {
      await service.close();
    }
  });

  it('delivers a warp transfer over Wormhole and LayerZero in one aggregation', async () => {
    const symbol = 'LZWH';
    const configPath = `${TEMP_PATH}/layerzero-wormhole-send-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    const [origin, destination] = chains;
    const wormholeChainIds: Record<string, number> = {
      [CHAIN_NAME_2]: WH_CHAIN_ID_2,
      [CHAIN_NAME_3]: WH_CHAIN_ID_3,
    };
    const multiProvider = await getMultiProvider();
    const wormholeMocks: Record<string, WormholeChainFixture> = {};
    for (const chain of chains) {
      wormholeMocks[chain] = await deployWormholeMocks(
        multiProvider,
        chain,
        wormholeChainIds[chain],
      );
    }
    const serviceUrl = `http://127.0.0.1:${COMBINED_SERVICE_PORT}`;
    const examples = readExampleChainConfigs();
    const config: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of chains.entries()) {
      const wormholeIsm: WormholeIsmConfig = {
        type: IsmType.WORMHOLE,
        owner: ANVIL_DEPLOYER_ADDRESS,
        core: wormholeMocks[chain].core.address,
        wormholeChainId: wormholeMocks[chain].wormholeChainId,
        consistencyLevel: { type: WormholeConsistencyType.Finalized },
        urls: [`${serviceUrl}/wormhole/getWormholeVaa`],
      };
      config[chain] = {
        type: index === 0 ? TokenType.native : TokenType.synthetic,
        owner: ANVIL_DEPLOYER_ADDRESS,
        mailbox: mailboxes[chain],
        name: `${symbol} token`,
        symbol,
        decimals: 18,
        hook: {
          type: HookType.AGGREGATION,
          hooks: [
            { type: HookType.MAILBOX_DEFAULT },
            { type: HookType.WORMHOLE },
            { type: HookType.LAYER_ZERO_V2 },
          ],
        },
        interchainSecurityModule: {
          type: IsmType.AGGREGATION,
          threshold: 2,
          modules: [
            wormholeIsm,
            layerZeroIsm(
              chain,
              chains.filter((remote) => remote !== chain),
              [`${serviceUrl}/layerzero/getLayerZeroPacket`],
              examples[index],
            ),
          ],
        },
      };
    }
    writeYamlOrJson(configPath, config);

    const deploy = await hyperlaneWarpDeploy(configPath, routeId);
    expect(deploy.exitCode).to.equal(0);

    const routers: Record<string, { wormhole: Address; layerZero: Address }> =
      {};
    for (const chain of chains) {
      const provider = multiProvider.getProvider(chain);
      const client = MailboxClient__factory.connect(
        getDeployedWarpAddress(chain, warpCorePath),
        provider,
      );
      const [hook, ism] = await Promise.all([
        client.hook(),
        client.interchainSecurityModule(),
      ]);
      const [modules, threshold] = await StaticAggregationIsm__factory.connect(
        ism,
        provider,
      ).modulesAndThreshold('0x');
      const children = await StaticAggregationHook__factory.connect(
        hook,
        provider,
      ).hooks('0x');
      expect(threshold).to.equal(2);
      expect(modules).to.have.length(2);
      expect(children).to.have.length(3);
      const routersByHookType = new Map<number, Address>();
      for (const module of modules) {
        expect(children.map((child) => child.toLowerCase())).to.include(
          module.toLowerCase(),
        );
        routersByHookType.set(
          await IPostDispatchHook__factory.connect(module, provider).hookType(),
          module,
        );
      }
      const wormholeRouter = routersByHookType.get(OnchainHookType.WORMHOLE);
      const layerZeroRouter = routersByHookType.get(OnchainHookType.LAYER_ZERO);
      assert(wormholeRouter, `Missing Wormhole router on ${chain}`);
      assert(layerZeroRouter, `Missing LayerZero router on ${chain}`);
      routers[chain] = { wormhole: wormholeRouter, layerZero: layerZeroRouter };
    }

    const check = await hyperlaneWarpCheck(routeId);
    expect(check.exitCode, check.stdout).to.equal(0);
    const apply = await hyperlaneWarpApply(routeId);
    expect(apply.exitCode).to.equal(0);
    expect(apply.stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );

    const signedVaas = new Map<string, string>();
    const upstream = await startVaaUpstream((vaaId) => signedVaas.get(vaaId));
    try {
      const service = await startCcipServer({
        port: COMBINED_SERVICE_PORT,
        modules: ['wormhole', 'layerzero'],
        env: wormholeServiceEnv({ upstreamUrl: upstream.url }),
      });
      try {
        const syntheticToken = ERC20__factory.connect(
          getDeployedWarpAddress(destination, warpCorePath),
          multiProvider.getProvider(destination),
        );
        const balanceBefore = await syntheticToken.balanceOf(
          ANVIL_DEPLOYER_ADDRESS,
        );

        const send = await hyperlaneWarpSendRelay({
          origin,
          destination,
          warpRouteId: routeId,
          relay: false,
          value: 2,
          quick: true,
        });
        expect(send.exitCode).to.equal(0);

        const mailbox = Mailbox__factory.connect(
          mailboxes[origin],
          multiProvider.getProvider(origin),
        );
        const dispatched = await mailbox.queryFilter(
          mailbox.filters.Dispatch(
            getDeployedWarpAddress(origin, warpCorePath),
          ),
        );
        expect(dispatched).to.have.length(1);
        const dispatchTx = dispatched[0].transactionHash;
        const publications = await readPublications(
          multiProvider,
          origin,
          dispatchTx,
          wormholeMocks[origin].core,
        );
        expect(publications).to.have.length(1);
        const [publication] = publications;
        signPublicationVaa(signedVaas, {
          wormholeChainId: wormholeMocks[origin].wormholeChainId,
          router: routers[origin].wormhole,
          publication,
        });

        const relayed = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        }).nothrow();
        expect(
          relayed.exitCode,
          `self-relay failed:\n${relayed.stdout}\n${relayed.stderr}`,
        ).to.equal(0);

        const balanceAfter = await syntheticToken.balanceOf(
          ANVIL_DEPLOYER_ADDRESS,
        );
        expect(balanceAfter.sub(balanceBefore).toString()).to.equal('2');
        expect(upstream.requestCount()).to.be.greaterThan(0);
      } finally {
        await service.close();
      }
    } finally {
      await upstream.close();
    }
  });
});
