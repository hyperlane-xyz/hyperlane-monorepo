import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  MailboxClient__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroUln302__factory,
  StaticAggregationHook__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  EvmLayerZeroV2HookIsmReader,
  HookType,
  IsmType,
  LayerZeroV2ConfigMode,
  TokenType,
} from '@hyperlane-xyz/sdk';
import type {
  IsmConfig,
  LayerZeroV2IsmConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { getDeployedWarpAddress } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

describe('warp deploy with LayerZero V2 combined hook/ISM', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);
  const chains = [CHAIN_NAME_2, CHAIN_NAME_3];
  const eids: Record<string, number> = {
    [CHAIN_NAME_2]: 40_101,
    [CHAIN_NAME_3]: 40_102,
  };
  let mailboxes: Record<string, Address>;
  let endpoints: Record<string, Address>;
  let sendLibraries: Record<string, Address>;
  let receiveLibraries: Record<string, Address>;

  before(async () => {
    const cores = await Promise.all(
      chains.map((chain) =>
        deployOrUseExistingCore(chain, CORE_CONFIG_PATH, ANVIL_KEY),
      ),
    );
    mailboxes = Object.fromEntries(
      chains.map((chain, index) => [chain, cores[index].mailbox]),
    );
    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    endpoints = {};
    sendLibraries = {};
    receiveLibraries = {};
    for (const chain of chains) {
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
      endpoints[chain] = endpoint.address;
      sendLibraries[chain] = sendLibrary.address;
      receiveLibraries[chain] = receiveLibrary.address;
    }
  });

  function layerZeroIsm(chain: string, remote: string): LayerZeroV2IsmConfig {
    return {
      type: IsmType.LAYER_ZERO_V2,
      owner: ANVIL_DEPLOYER_ADDRESS,
      endpoint: endpoints[chain],
      layerZeroDomainId: eids[chain],
      urls: ['http://127.0.0.1:3000/layerzero/getLayerZeroPacket'],
      pathways: {
        [remote]: {
          layerZeroDomainId: eids[remote],
          sendLibrary: sendLibraries[chain],
          receiveLibrary: receiveLibraries[chain],
          sendConfig: {
            executor: { type: LayerZeroV2ConfigMode.Default },
            uln: { type: LayerZeroV2ConfigMode.Default },
          },
          receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
        },
      },
    };
  }

  function configFor(
    symbol: string,
    wrapIsm: (ism: LayerZeroV2IsmConfig) => IsmConfig = (ism) => ism,
  ): WarpRouteDeployConfigMailboxRequired {
    const configs: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of chains.entries()) {
      const remote = chains[index === 0 ? 1 : 0];
      configs[chain] = {
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
            { type: HookType.LAYER_ZERO_V2 },
          ],
        },
        interchainSecurityModule: wrapIsm(layerZeroIsm(chain, remote)),
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
      configFor(symbol, (ism) => ({
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [ism],
      })),
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
});
