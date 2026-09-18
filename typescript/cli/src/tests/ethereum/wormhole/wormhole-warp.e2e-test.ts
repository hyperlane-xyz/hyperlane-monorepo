import { expect } from 'chai';
import { constants } from 'ethers';

import {
  DefaultHook__factory,
  MailboxClient__factory,
  StaticAggregationHook__factory,
  WormholeExecutorHookIsm__factory,
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
  WormholeVariant,
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
  CALLBACK_GAS_LIMIT,
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

  function configFor(
    variant: WormholeVariant,
    symbol: string,
  ): WarpRouteDeployConfigMailboxRequired {
    const configs: WarpRouteDeployConfigMailboxRequired = {};
    for (const [index, chain] of chains.entries()) {
      const remote = chains[index === 0 ? 1 : 0];
      const wormholeHook: HookConfig =
        variant === WormholeVariant.Executor
          ? {
              type: HookType.WORMHOLE_EXECUTOR,
              executorQuoterRouter: mocks[chain].quoterRouter.address,
              routes: {
                [remote]: {
                  quoter: ANVIL_DEPLOYER_ADDRESS,
                  callbackGasLimit: CALLBACK_GAS_LIMIT,
                },
              },
            }
          : { type: HookType.WORMHOLE_VAA };
      const hook: HookConfig = {
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MAILBOX_DEFAULT }, wormholeHook],
      };
      const interchainSecurityModule =
        variant === WormholeVariant.Executor
          ? {
              type: IsmType.WORMHOLE_EXECUTOR,
              owner: ANVIL_DEPLOYER_ADDRESS,
              core: mocks[chain].core.address,
              wormholeChainId: mocks[chain].wormholeChainId,
              consistencyLevel: { type: WormholeConsistencyType.Finalized },
            }
          : {
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
    variant: WormholeVariant,
  ): Promise<void> {
    const readConfig = await readWarpConfig(chain, warpCorePath, outputPath, {
      preserveExistingChains: false,
    });
    const hook = readConfig[chain].hook;
    assert(
      typeof hook !== 'string' && hook?.type === HookType.AGGREGATION,
      `Expected aggregation hook on ${chain}`,
    );
    const expectedType =
      variant === WormholeVariant.Executor
        ? HookType.WORMHOLE_EXECUTOR
        : HookType.WORMHOLE_VAA;
    const wormholeHook = hook.hooks.find(
      (child) => typeof child !== 'string' && child.type === expectedType,
    );
    assert(
      typeof wormholeHook !== 'string' && wormholeHook,
      `Expected expanded ${expectedType} child on ${chain}`,
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

  for (const [variant, symbol] of [
    [WormholeVariant.Executor, 'WHEX'],
    [WormholeVariant.DirectVaa, 'WHVA'],
  ] as const) {
    describe(variant, () => {
      const configPath = `${TEMP_PATH}/wormhole-${variant}-warp.yaml`;
      const routeId = getWarpRouteId(symbol, chains);
      const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
      let config: WarpRouteDeployConfigMailboxRequired;
      let wormholeRouters: Record<string, Address>;
      let aggregationHooks: Record<string, Address>;

      it('adds Wormhole to an existing route through warp apply', async () => {
        const transitionSymbol = `${symbol}A`;
        const transitionConfigPath = `${TEMP_PATH}/wormhole-${variant}-apply-warp.yaml`;
        const transitionRouteId = getWarpRouteId(transitionSymbol, chains);
        const transitionWarpCorePath = getCombinedWarpRoutePath(
          transitionSymbol,
          chains,
        );
        const target = configFor(variant, transitionSymbol);

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
            `${TEMP_PATH}/wormhole-${variant}-${chain}-read.yaml`,
            variant,
          );
        }
      });

      it('deploys and updates through the real warp commands', async () => {
        config = configFor(variant, symbol);
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
          expect(derived.type).to.equal(variant);
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
          domain: multiProvider.getDomainId(driftRemote),
          router: addressToBytes32(wormholeRouters[driftRemote]),
          wormholeChainId: WH_CHAIN_ID_3,
          expectedConsistencyLevel: WormholeConsistencyLevel.Safe,
        };
        setSignerForChain(multiProvider, driftChain, ANVIL_KEY);
        const signer = multiProvider.getSigner(driftChain);
        let enrollmentData: string;
        if (variant === WormholeVariant.Executor) {
          enrollmentData =
            WormholeExecutorHookIsm__factory.createInterface().encodeFunctionData(
              'enrollRemoteRouter(((uint32,bytes32,uint16,uint8),address,uint128))',
              [
                {
                  remoteRouter: remoteRouterEnrollment,
                  quoter: ANVIL_DEPLOYER_ADDRESS,
                  callbackGasLimit: CALLBACK_GAS_LIMIT,
                },
              ],
            );
        } else {
          enrollmentData =
            WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
              'enrollRemoteRouter((uint32,bytes32,uint16,uint8))',
              [remoteRouterEnrollment],
            );
        }
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

        if (variant === WormholeVariant.Executor) {
          for (const chain of chains) {
            const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
            const hook = config[chain].hook;
            if (
              typeof hook !== 'string' &&
              hook?.type === HookType.AGGREGATION
            ) {
              const wormholeHook = hook.hooks.find(
                (child) =>
                  typeof child !== 'string' &&
                  child.type === HookType.WORMHOLE_EXECUTOR,
              );
              if (
                typeof wormholeHook !== 'string' &&
                wormholeHook?.type === HookType.WORMHOLE_EXECUTOR
              ) {
                wormholeHook.routes[remote].callbackGasLimit = 500_000n;
              }
            }
          }
        } else {
          for (const chain of chains) {
            const ism = config[chain].interchainSecurityModule;
            if (typeof ism !== 'string' && ism?.type === IsmType.WORMHOLE_VAA) {
              ism.urls = ['https://vaa.example/v2'];
            }
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

          const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
          const derived = await new EvmWormholeHookIsmReader(
            multiProvider,
            chain,
          ).deriveWormholeConfig(wormholeRouters[chain]);
          if (variant === WormholeVariant.Executor) {
            expect(derived.remoteRouters[remote].callbackGasLimit).to.equal(
              500_000n,
            );
          } else {
            expect(derived.urls).to.deep.equal(['https://vaa.example/v2']);
          }
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
            typeof ism !== 'string' &&
              ism &&
              (ism.type === IsmType.WORMHOLE_EXECUTOR ||
                ism.type === IsmType.WORMHOLE_VAA),
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
  }
});
