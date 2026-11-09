import { expect } from 'chai';
import { constants } from 'ethers';

import {
  DefaultHook__factory,
  ERC20__factory,
  MailboxClient__factory,
  ProxyAdmin__factory,
  StaticAggregationHook__factory,
  StaticAggregationIsm__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  EvmWormholeHookIsmReader,
  type HookConfig,
  HookType,
  type IsmConfig,
  IsmType,
  TokenType,
  type WarpRouteDeployConfigMailboxRequired,
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  type WormholeIsmConfig,
  proxyAdmin,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, type Address } from '@hyperlane-xyz/utils';

import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  getDeployedWarpAddress,
  hyperlaneStatus,
  setSignerForChain,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

import {
  WH_CHAIN_ID_2,
  WH_CHAIN_ID_3,
  WH_CHAIN_ID_4,
  type WormholeChainFixture,
  deployWormholeMocks,
  getMultiProvider,
  readPublications,
  signPublicationVaa,
  startVaaUpstream,
  startWormholeVaaService,
} from './fixtures.js';

const VAA_SERVICE_PORT = 3802;
const VAA_SERVICE_URL = `http://127.0.0.1:${VAA_SERVICE_PORT}/wormhole/getWormholeVaa`;
// Anvil account #1: distinct from both the deployer and the warp route owner.
const WORMHOLE_ROUTER_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('hyperlane warp deploy/apply with Wormhole hook/ISM', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);

  const chains = [CHAIN_NAME_2, CHAIN_NAME_3];
  let mailboxes: Record<string, Address>;
  let mocks: Record<string, WormholeChainFixture>;

  before(async () => {
    const [chain2Core, chain3Core, chain4Core] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
    mailboxes = {
      [CHAIN_NAME_2]: chain2Core.mailbox,
      [CHAIN_NAME_3]: chain3Core.mailbox,
      [CHAIN_NAME_4]: chain4Core.mailbox,
    };

    const multiProvider = await getMultiProvider();
    mocks = {
      [CHAIN_NAME_2]: await deployWormholeMocks(
        multiProvider,
        CHAIN_NAME_2,
        WH_CHAIN_ID_2,
      ),
      [CHAIN_NAME_3]: await deployWormholeMocks(
        multiProvider,
        CHAIN_NAME_3,
        WH_CHAIN_ID_3,
      ),
      [CHAIN_NAME_4]: await deployWormholeMocks(
        multiProvider,
        CHAIN_NAME_4,
        WH_CHAIN_ID_4,
      ),
    };
  });

  function configFor(
    symbol: string,
    urls: string[] = ['https://vaa.example/v1'],
    wrapIsm: (ism: WormholeIsmConfig) => IsmConfig = (ism) => ism,
  ): WarpRouteDeployConfigMailboxRequired {
    const configs: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of chains.entries()) {
      const hook: HookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          { type: HookType.MAILBOX_DEFAULT },
          { type: HookType.WORMHOLE },
        ],
      };
      const interchainSecurityModule: WormholeIsmConfig = {
        type: IsmType.WORMHOLE,
        owner: ANVIL_DEPLOYER_ADDRESS,
        core: mocks[chain].core.address,
        wormholeChainId: mocks[chain].wormholeChainId,
        consistencyLevel: { type: WormholeConsistencyType.Finalized },
        urls,
      };
      configs[chain] = {
        type: index === 0 ? TokenType.native : TokenType.synthetic,
        owner: ANVIL_DEPLOYER_ADDRESS,
        mailbox: mailboxes[chain],
        name: `${symbol} token`,
        symbol,
        decimals: 18,
        hook,
        interchainSecurityModule: wrapIsm(interchainSecurityModule),
      };
    }
    return configs;
  }

  async function installedWormholeRouters(
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

  function withoutWormhole(
    config: WarpRouteDeployConfigMailboxRequired,
  ): WarpRouteDeployConfigMailboxRequired {
    return Object.fromEntries(
      Object.entries(config).map(([chain, chainConfig]) => [
        chain,
        {
          ...chainConfig,
          hook: { type: HookType.MAILBOX_DEFAULT },
          interchainSecurityModule: constants.AddressZero,
        },
      ]),
    );
  }

  async function assertWormholeHookIsExpanded(
    chain: string,
    warpCorePath: string,
    outputPath: string,
  ): Promise<void> {
    const readConfig = await readWarpConfig(chain, warpCorePath, outputPath, {
      preserveExistingChains: false,
    });
    const hook = readConfig[chain].hook;
    assert(
      typeof hook !== 'string' && hook?.type === HookType.AGGREGATION,
      `Expected aggregation hook on ${chain}`,
    );
    const wormholeHook = hook.hooks.find(
      (child) => typeof child !== 'string' && child.type === HookType.WORMHOLE,
    );
    assert(
      typeof wormholeHook !== 'string' && wormholeHook,
      `Expected expanded ${HookType.WORMHOLE} child on ${chain}`,
    );
    assert(
      'remoteRouters' in wormholeHook &&
        typeof wormholeHook.remoteRouters === 'object' &&
        wormholeHook.remoteRouters !== null,
      `Expected expanded Wormhole remote routers on ${chain}`,
    );
    const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
    assert(
      remote in wormholeHook.remoteRouters,
      `Expected expanded ${remote} Wormhole router on ${chain}`,
    );
  }

  describe('wormholeVaa', () => {
    const symbol = 'WHVA';
    const configPath = `${TEMP_PATH}/wormhole-vaa-warp.yaml`;
    const routeId = getWarpRouteId(symbol, chains);
    const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
    let config: WarpRouteDeployConfigMailboxRequired;
    let wormholeRouters: Record<string, Address>;
    let aggregationHooks: Record<string, Address>;

    it('adds Wormhole to an existing route through warp apply', async () => {
      const transitionSymbol = `${symbol}A`;
      const transitionConfigPath = `${TEMP_PATH}/wormhole-vaa-apply-warp.yaml`;
      const transitionRouteId = getWarpRouteId(transitionSymbol, chains);
      const transitionWarpCorePath = getCombinedWarpRoutePath(
        transitionSymbol,
        chains,
      );
      const target = configFor(transitionSymbol);

      writeYamlOrJson(transitionConfigPath, withoutWormhole(target));
      const deployResult = await hyperlaneWarpDeploy(
        transitionConfigPath,
        transitionRouteId,
      );
      expect(deployResult.exitCode).to.equal(0);

      writeYamlOrJson(transitionConfigPath, target);
      syncWarpDeployConfigToRegistry({
        warpDeployPath: transitionConfigPath,
        warpRouteId: transitionRouteId,
        registryPath: REGISTRY_PATH,
      });
      const applyResult = await hyperlaneWarpApply(transitionRouteId);
      expect(applyResult.exitCode).to.equal(0);

      const multiProvider = await getMultiProvider();
      for (const chain of chains) {
        const warpRouter = getDeployedWarpAddress(
          chain,
          transitionWarpCorePath,
        );
        const client = MailboxClient__factory.connect(
          warpRouter,
          multiProvider.getProvider(chain),
        );
        const [hookAddress, ismAddress] = await Promise.all([
          client.hook(),
          client.interchainSecurityModule(),
        ]);
        expect(ismAddress).not.to.equal(constants.AddressZero);
        const childHooks = await StaticAggregationHook__factory.connect(
          hookAddress,
          multiProvider.getProvider(chain),
        ).hooks('0x');
        expect(childHooks).to.include(ismAddress);

        await assertWormholeHookIsExpanded(
          chain,
          transitionWarpCorePath,
          `${TEMP_PATH}/wormhole-vaa-${chain}-read.yaml`,
        );
      }
    });

    it('deploys and updates through the real warp commands', async () => {
      config = configFor(symbol);
      writeYamlOrJson(configPath, config);

      const result = await hyperlaneWarpDeploy(configPath, routeId);
      expect(result.exitCode).to.equal(0);

      const multiProvider = await getMultiProvider();
      wormholeRouters = {};
      aggregationHooks = {};
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
        expect(hook).not.to.equal(ism);
        aggregationHooks[chain] = hook;
        wormholeRouters[chain] = ism;

        const childHooks = await StaticAggregationHook__factory.connect(
          hook,
          multiProvider.getProvider(chain),
        ).hooks('0x');
        const defaultHook = childHooks.find(
          (address) => address.toLowerCase() !== ism.toLowerCase(),
        );
        assert(defaultHook, `Missing default hook on ${chain}`);
        expect(childHooks).to.have.length(2);
        expect(
          await DefaultHook__factory.connect(
            defaultHook,
            multiProvider.getProvider(chain),
          ).mailbox(),
        ).to.equal(mailboxes[chain]);

        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(ism);
        expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
          wormholeRouters[remote]?.toLowerCase() ??
            derived.remoteRouters[remote].router.toLowerCase(),
        );
      }

      // Assert reciprocal addresses after both local addresses are known.
      for (const chain of chains) {
        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(wormholeRouters[chain]);
        expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
          wormholeRouters[remote].toLowerCase(),
        );
      }

      const healthyCheck = await hyperlaneWarpCheck(routeId);
      expect(healthyCheck.exitCode).to.equal(0);

      // Trust-policy drift lives on the combined hook/ISM, outside the token
      // router. Check must expose it and apply must repair it.
      const driftChain = CHAIN_NAME_2;
      const driftRemote = CHAIN_NAME_3;
      const remoteRouterEnrollment = {
        domainId: multiProvider.getDomainId(driftRemote),
        domainIsm: addressToBytes32(wormholeRouters[driftRemote]),
        wormholeChainId: WH_CHAIN_ID_3,
        expectedConsistencyLevel: WormholeConsistencyLevel.Safe,
        expectedCustomBaseConsistencyLevel: 0,
        expectedAdditionalBlocks: 0,
      };
      setSignerForChain(multiProvider, driftChain, ANVIL_KEY);
      const signer = multiProvider.getSigner(driftChain);
      const enrollmentData =
        WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
          'enrollRemoteRouters((uint32,bytes32,uint16,uint8,uint8,uint16)[])',
          [[remoteRouterEnrollment]],
        );
      await (
        await signer.sendTransaction({
          to: wormholeRouters[driftChain],
          data: enrollmentData,
        })
      ).wait();

      const driftCheck = await hyperlaneWarpCheck(routeId).nothrow();
      expect(driftCheck.exitCode).not.to.equal(0);
      expect(`${driftCheck.stdout}\n${driftCheck.stderr}`).to.include(
        'wormholeRemoteRouters',
      );

      const repairApply = await hyperlaneWarpApply(routeId);
      expect(repairApply.exitCode).to.equal(0);
      const repairedCheck = await hyperlaneWarpCheck(routeId);
      expect(repairedCheck.exitCode).to.equal(0);

      for (const chain of chains) {
        const ism = config[chain].interchainSecurityModule;
        if (typeof ism !== 'string' && ism?.type === IsmType.WORMHOLE) {
          ism.urls = ['https://vaa.example/v2'];
        }
      }
      writeYamlOrJson(configPath, config);
      syncWarpDeployConfigToRegistry({
        warpDeployPath: configPath,
        warpRouteId: routeId,
        registryPath: REGISTRY_PATH,
      });

      const applyResult = await hyperlaneWarpApply(routeId);
      expect(applyResult.exitCode).to.equal(0);

      for (const chain of chains) {
        const warpRouter = getDeployedWarpAddress(chain, warpCorePath);
        const client = MailboxClient__factory.connect(
          warpRouter,
          multiProvider.getProvider(chain),
        );
        expect(await client.hook()).to.equal(aggregationHooks[chain]);
        expect(await client.interchainSecurityModule()).to.equal(
          wormholeRouters[chain],
        );

        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(wormholeRouters[chain]);
        expect(derived.urls).to.deep.equal(['https://vaa.example/v2']);
      }

      const idempotent = await hyperlaneWarpApply(routeId);
      expect(idempotent.exitCode).to.equal(0);
      expect(idempotent.stdout).to.include(
        'Warp config is the same as target. No updates needed.',
      );

      const previousRouters = { ...wormholeRouters };
      for (const chain of chains) {
        const ism = config[chain].interchainSecurityModule;
        assert(
          typeof ism !== 'string' && ism?.type === IsmType.WORMHOLE,
          `Expected Wormhole ISM config on ${chain}`,
        );
        ism.consistencyLevel = {
          type: WormholeConsistencyType.Instant,
        };
      }
      writeYamlOrJson(configPath, config);
      syncWarpDeployConfigToRegistry({
        warpDeployPath: configPath,
        warpRouteId: routeId,
        registryPath: REGISTRY_PATH,
      });

      const immutableApply = await hyperlaneWarpApply(routeId);
      expect(immutableApply.exitCode).to.equal(0);

      const replacements: Record<string, Address> = {};
      for (const chain of chains) {
        const warpRouter = getDeployedWarpAddress(chain, warpCorePath);
        const client = MailboxClient__factory.connect(
          warpRouter,
          multiProvider.getProvider(chain),
        );
        const replacement = await client.interchainSecurityModule();
        expect(replacement).not.to.equal(previousRouters[chain]);
        const childHooks = await StaticAggregationHook__factory.connect(
          await client.hook(),
          multiProvider.getProvider(chain),
        ).hooks('0x');
        expect(childHooks).to.include(replacement);
        replacements[chain] = replacement;
      }

      for (const chain of chains) {
        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(replacements[chain]);
        expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
          replacements[remote].toLowerCase(),
        );
      }
      const replacedCheck = await hyperlaneWarpCheck(routeId);
      expect(replacedCheck.exitCode).to.equal(0);
    });

    it('deploys and checks a Wormhole ISM nested in an aggregation ISM', async () => {
      const nestedSymbol = `${symbol}N`;
      const nestedConfigPath = `${TEMP_PATH}/wormhole-vaa-nested-warp.yaml`;
      const nestedRouteId = getWarpRouteId(nestedSymbol, chains);
      const nestedWarpCorePath = getCombinedWarpRoutePath(nestedSymbol, chains);
      writeYamlOrJson(
        nestedConfigPath,
        configFor(nestedSymbol, undefined, (ism) => ({
          type: IsmType.AGGREGATION,
          threshold: 1,
          modules: [ism],
        })),
      );

      const deployResult = await hyperlaneWarpDeploy(
        nestedConfigPath,
        nestedRouteId,
      );
      expect(deployResult.exitCode).to.equal(0);

      const multiProvider = await getMultiProvider();
      for (const chain of chains) {
        const client = MailboxClient__factory.connect(
          getDeployedWarpAddress(chain, nestedWarpCorePath),
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
        const childHooks = await StaticAggregationHook__factory.connect(
          hook,
          multiProvider.getProvider(chain),
        ).hooks('0x');
        expect(modules).to.have.length(1);
        expect(childHooks).to.include(modules[0]);
      }

      const check = await hyperlaneWarpCheck(nestedRouteId);
      expect(check.exitCode, check.stdout).to.equal(0);
      const apply = await hyperlaneWarpApply(nestedRouteId);
      expect(apply.exitCode).to.equal(0);
      expect(apply.stdout).to.include(
        'Warp config is the same as target. No updates needed.',
      );
    });

    it('hands the route and Wormhole routers to non-deployer owners on deploy', async () => {
      const ownerSymbol = `${symbol}O`;
      const ownerConfigPath = `${TEMP_PATH}/wormhole-vaa-owner-warp.yaml`;
      const ownerRouteId = getWarpRouteId(ownerSymbol, chains);
      const ownerWarpCorePath = getCombinedWarpRoutePath(ownerSymbol, chains);
      const meshConfig = configFor(ownerSymbol, undefined, (ism) => ({
        type: ism.type,
        owner: WORMHOLE_ROUTER_OWNER,
        core: ism.core,
        wormholeChainId: ism.wormholeChainId,
        consistencyLevel: ism.consistencyLevel,
        urls: ism.urls,
      }));
      const ownerConfig: WarpRouteDeployConfigMailboxRequired =
        Object.fromEntries(
          Object.entries(meshConfig).map(([chain, chainConfig]) => [
            chain,
            { ...chainConfig, owner: E2E_TEST_BURN_ADDRESS },
          ]),
        );
      writeYamlOrJson(ownerConfigPath, ownerConfig);

      const deployResult = await hyperlaneWarpDeploy(
        ownerConfigPath,
        ownerRouteId,
      );
      expect(deployResult.exitCode).to.equal(0);

      const multiProvider = await getMultiProvider();
      const routers = await installedWormholeRouters(ownerWarpCorePath, chains);
      for (const chain of chains) {
        const provider = multiProvider.getProvider(chain);
        const warpRouter = getDeployedWarpAddress(chain, ownerWarpCorePath);
        const client = MailboxClient__factory.connect(warpRouter, provider);
        expect(await client.owner()).to.equal(E2E_TEST_BURN_ADDRESS);
        expect(
          await ProxyAdmin__factory.connect(
            await proxyAdmin(provider, warpRouter),
            provider,
          ).owner(),
        ).to.equal(E2E_TEST_BURN_ADDRESS);

        expect(
          await WormholeVaaHookIsm__factory.connect(
            routers[chain],
            provider,
          ).owner(),
        ).to.equal(WORMHOLE_ROUTER_OWNER);
        const childHooks = await StaticAggregationHook__factory.connect(
          await client.hook(),
          provider,
        ).hooks('0x');
        expect(childHooks).to.have.length(2);
        expect(childHooks).to.include(routers[chain]);

        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(routers[chain]);
        expect(Object.keys(derived.remoteRouters)).to.have.members([remote]);
        expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
          routers[remote].toLowerCase(),
        );
      }

      const check = await hyperlaneWarpCheck(ownerRouteId);
      expect(check.exitCode, check.stdout).to.equal(0);
    });

    it('delivers a warp transfer over Wormhole through the lookup service', async () => {
      const sendSymbol = `${symbol}S`;
      const sendConfigPath = `${TEMP_PATH}/wormhole-vaa-send-warp.yaml`;
      const sendRouteId = getWarpRouteId(sendSymbol, chains);
      const sendWarpCorePath = getCombinedWarpRoutePath(sendSymbol, chains);
      const [origin, destination] = chains;
      writeYamlOrJson(sendConfigPath, configFor(sendSymbol, [VAA_SERVICE_URL]));
      const deployResult = await hyperlaneWarpDeploy(
        sendConfigPath,
        sendRouteId,
      );
      expect(deployResult.exitCode).to.equal(0);
      const routers = await installedWormholeRouters(sendWarpCorePath, chains);

      const signedVaas = new Map<string, string>();
      const upstream = await startVaaUpstream((vaaId) => signedVaas.get(vaaId));
      const service = await startWormholeVaaService({
        port: VAA_SERVICE_PORT,
        upstreamUrl: upstream.url,
      });
      try {
        const multiProvider = await getMultiProvider();
        const syntheticToken = ERC20__factory.connect(
          getDeployedWarpAddress(destination, sendWarpCorePath),
          multiProvider.getProvider(destination),
        );
        const balanceBefore = await syntheticToken.balanceOf(
          ANVIL_DEPLOYER_ADDRESS,
        );
        const originCore = mocks[origin].core.connect(
          multiProvider.getProvider(origin),
        );

        const send = await hyperlaneWarpSendRelay({
          origin,
          destination,
          warpRouteId: sendRouteId,
          relay: false,
          value: 2,
          quick: true,
        });
        expect(send.exitCode).to.equal(0);

        const published = await originCore.queryFilter(
          originCore.filters.LogMessagePublished(routers[origin]),
        );
        expect(published).to.have.length(1);
        const dispatchTx = published[0].transactionHash;
        const [publication] = await readPublications(
          multiProvider,
          origin,
          dispatchTx,
          mocks[origin].core,
        );
        assert(publication, `Missing Wormhole publication on ${origin}`);
        signPublicationVaa(signedVaas, {
          wormholeChainId: mocks[origin].wormholeChainId,
          router: routers[origin],
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
        await upstream.close();
      }
    });

    it('extends the route to a third chain through warp apply', async () => {
      const extendSymbol = `${symbol}E`;
      const extendConfigPath = `${TEMP_PATH}/wormhole-vaa-extend-warp.yaml`;
      const extendRouteId = getWarpRouteId(extendSymbol, chains);
      const extendWarpCorePath = getCombinedWarpRoutePath(extendSymbol, chains);
      const extendConfig = configFor(extendSymbol);
      writeYamlOrJson(extendConfigPath, extendConfig);
      const deployResult = await hyperlaneWarpDeploy(
        extendConfigPath,
        extendRouteId,
      );
      expect(deployResult.exitCode).to.equal(0);
      const existingRouters = await installedWormholeRouters(
        extendWarpCorePath,
        chains,
      );

      extendConfig[CHAIN_NAME_4] = {
        type: TokenType.synthetic,
        owner: ANVIL_DEPLOYER_ADDRESS,
        mailbox: mailboxes[CHAIN_NAME_4],
        name: `${extendSymbol} token`,
        symbol: extendSymbol,
        decimals: 18,
        hook: {
          type: HookType.AGGREGATION,
          hooks: [
            { type: HookType.MAILBOX_DEFAULT },
            { type: HookType.WORMHOLE },
          ],
        },
        interchainSecurityModule: {
          type: IsmType.WORMHOLE,
          owner: ANVIL_DEPLOYER_ADDRESS,
          core: mocks[CHAIN_NAME_4].core.address,
          wormholeChainId: mocks[CHAIN_NAME_4].wormholeChainId,
          consistencyLevel: { type: WormholeConsistencyType.Finalized },
          urls: ['https://vaa.example/v1'],
        },
      };
      writeYamlOrJson(extendConfigPath, extendConfig);
      syncWarpDeployConfigToRegistry({
        warpDeployPath: extendConfigPath,
        warpRouteId: extendRouteId,
        registryPath: REGISTRY_PATH,
      });

      const extendApply = await hyperlaneWarpApply(extendRouteId);
      expect(extendApply.exitCode).to.equal(0);

      const extendedChains = [...chains, CHAIN_NAME_4];
      const routers = await installedWormholeRouters(
        extendWarpCorePath,
        extendedChains,
      );
      for (const chain of chains) {
        expect(routers[chain]).to.equal(existingRouters[chain]);
      }
      const multiProvider = await getMultiProvider();
      for (const chain of extendedChains) {
        const derived = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(routers[chain]);
        const remotes = extendedChains.filter((remote) => remote !== chain);
        expect(Object.keys(derived.remoteRouters)).to.have.members(remotes);
        for (const remote of remotes) {
          expect(derived.remoteRouters[remote].router.toLowerCase()).to.equal(
            routers[remote].toLowerCase(),
          );
          expect(derived.remoteRouters[remote].wormholeChainId).to.equal(
            mocks[remote].wormholeChainId,
          );
        }
      }

      const extendedCheck = await hyperlaneWarpCheck(extendRouteId);
      expect(extendedCheck.exitCode).to.equal(0);
    });
  });
});
