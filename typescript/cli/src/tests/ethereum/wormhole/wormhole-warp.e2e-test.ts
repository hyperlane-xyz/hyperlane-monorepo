import { expect } from 'chai';
import { constants } from 'ethers';

import {
  DefaultHook__factory,
  MailboxClient__factory,
  StaticAggregationHook__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  EvmWormholeHookIsmReader,
  type HookConfig,
  HookType,
  IsmType,
  TokenType,
  type WarpRouteDeployConfigMailboxRequired,
  WormholeConsistencyLevel,
  WormholeConsistencyType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, type Address } from '@hyperlane-xyz/utils';

import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  getDeployedWarpAddress,
  setSignerForChain,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  readWarpConfig,
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

import {
  WH_CHAIN_ID_2,
  WH_CHAIN_ID_3,
  type WormholeChainFixture,
  deployWormholeMocks,
  getMultiProvider,
} from './fixtures.js';

describe('hyperlane warp deploy/apply with Wormhole hook/ISM', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);

  const chains = [CHAIN_NAME_2, CHAIN_NAME_3];
  let mailboxes: Record<string, Address>;
  let mocks: Record<string, WormholeChainFixture>;

  before(async () => {
    const [chain2Core, chain3Core] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
    mailboxes = {
      [CHAIN_NAME_2]: chain2Core.mailbox,
      [CHAIN_NAME_3]: chain3Core.mailbox,
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
    };
  });

  function configFor(symbol: string): WarpRouteDeployConfigMailboxRequired {
    const configs: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of chains.entries()) {
      const hook: HookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          { type: HookType.MAILBOX_DEFAULT },
          { type: HookType.WORMHOLE_VAA },
        ],
      };
      const interchainSecurityModule = {
        type: IsmType.WORMHOLE_VAA,
        owner: ANVIL_DEPLOYER_ADDRESS,
        core: mocks[chain].core.address,
        wormholeChainId: mocks[chain].wormholeChainId,
        consistencyLevel: { type: WormholeConsistencyType.Finalized },
        urls: ['https://vaa.example/v1'],
      };
      configs[chain] = {
        type: index === 0 ? TokenType.native : TokenType.synthetic,
        owner: ANVIL_DEPLOYER_ADDRESS,
        mailbox: mailboxes[chain],
        name: `${symbol} token`,
        symbol,
        decimals: 18,
        hook,
        interchainSecurityModule,
      };
    }
    return configs;
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
      (child) =>
        typeof child !== 'string' && child.type === HookType.WORMHOLE_VAA,
    );
    assert(
      typeof wormholeHook !== 'string' && wormholeHook,
      `Expected expanded ${HookType.WORMHOLE_VAA} child on ${chain}`,
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
        if (typeof ism !== 'string' && ism?.type === IsmType.WORMHOLE_VAA) {
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
          typeof ism !== 'string' && ism?.type === IsmType.WORMHOLE_VAA,
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
      }
    });
  });
});
