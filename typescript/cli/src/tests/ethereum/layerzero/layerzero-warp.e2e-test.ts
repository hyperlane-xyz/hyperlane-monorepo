import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  MailboxClient__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroReceiveUln__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import {
  EvmLayerZeroV2HookIsmReader,
  findLayerZeroV2Hooks,
  HookType,
  IsmType,
  LayerZeroV2ConfigMode,
  LayerZeroV2Variant,
  TokenType,
} from '@hyperlane-xyz/sdk';
import type { WarpRouteDeployConfigMailboxRequired } from '@hyperlane-xyz/sdk';
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
        new MockLayerZeroReceiveUln__factory(),
        [endpoint.address],
      );
      const receiveLibrary = await multiProvider.handleDeploy(
        chain,
        new MockLayerZeroReceiveUln__factory(),
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

  function configFor(
    variant: LayerZeroV2Variant,
    symbol: string,
  ): WarpRouteDeployConfigMailboxRequired {
    return Object.fromEntries(
      chains.map((chain, index) => {
        const remote = chains[index === 0 ? 1 : 0];
        const hookLeaf =
          variant === LayerZeroV2Variant.Callback
            ? {
                type: HookType.LAYER_ZERO_V2_CALLBACK,
                callbackGasLimits: { [remote]: 250_000n },
              }
            : { type: HookType.LAYER_ZERO_V2_CCIP_READ };
        const ism = {
          type:
            variant === LayerZeroV2Variant.Callback
              ? IsmType.LAYER_ZERO_V2_CALLBACK
              : IsmType.LAYER_ZERO_V2_CCIP_READ,
          owner: ANVIL_DEPLOYER_ADDRESS,
          endpoint: endpoints[chain],
          layerZeroDomainId: eids[chain],
          pathways: {
            [remote]: {
              layerZeroDomainId: eids[remote],
              sendLibrary: sendLibraries[chain],
              receiveLibrary: receiveLibraries[chain],
              receiveLibraryGracePeriod: 0,
              sendConfig: {
                executor: { type: 'default' },
                uln: { type: 'default' },
              },
              receiveConfig: { uln: { type: 'default' } },
            },
          },
          ...(variant === LayerZeroV2Variant.CcipRead
            ? {
                urls: ['http://127.0.0.1:3000/layerzero/getLayerZeroPacket'],
              }
            : {}),
        };
        return [
          chain,
          {
            type: index === 0 ? TokenType.native : TokenType.synthetic,
            owner: ANVIL_DEPLOYER_ADDRESS,
            mailbox: mailboxes[chain],
            name: `${symbol} token`,
            symbol,
            decimals: 18,
            hook: {
              type: HookType.AGGREGATION,
              hooks: [{ type: HookType.MAILBOX_DEFAULT }, hookLeaf],
            },
            interchainSecurityModule: ism,
          },
        ];
      }),
    ) as WarpRouteDeployConfigMailboxRequired;
  }

  function orderedDvns(chain: string): Address[] {
    return [sendLibraries[chain], receiveLibraries[chain]].toSorted((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  for (const [variant, symbol] of [
    [LayerZeroV2Variant.Callback, 'LZCB'],
    [LayerZeroV2Variant.CcipRead, 'LZCR'],
  ] as const) {
    it(`deploys and checks the ${variant} mesh`, async () => {
      const configPath = `${TEMP_PATH}/layerzero-${variant}-warp.yaml`;
      const routeId = getWarpRouteId(symbol, chains);
      const warpCorePath = getCombinedWarpRoutePath(symbol, chains);
      writeYamlOrJson(configPath, configFor(variant, symbol));

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
        const derived = await new EvmLayerZeroV2HookIsmReader(
          multiProvider,
          chain,
        ).deriveLayerZeroConfig(ism);
        expect(derived.type).to.equal(variant);
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

      const updatedConfig = configFor(variant, symbol);
      for (const chain of chains) {
        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        const requiredDVNs = orderedDvns(chain);
        const ism = updatedConfig[chain].interchainSecurityModule;
        assert(
          typeof ism !== 'string' &&
            ism &&
            (ism.type === IsmType.LAYER_ZERO_V2_CALLBACK ||
              ism.type === IsmType.LAYER_ZERO_V2_CCIP_READ),
          `Missing LayerZero ISM on ${chain}`,
        );
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
        if (variant === LayerZeroV2Variant.Callback) {
          const hook = findLayerZeroV2Hooks(updatedConfig[chain].hook)[0];
          assert(
            hook?.type === HookType.LAYER_ZERO_V2_CALLBACK,
            'Missing callback hook',
          );
          hook.callbackGasLimits[remote] = 333_333n;
        } else {
          const ism = updatedConfig[chain].interchainSecurityModule;
          assert(
            typeof ism !== 'string' &&
              ism?.type === IsmType.LAYER_ZERO_V2_CCIP_READ,
            'Missing CCIP-read ISM',
          );
          ism.urls = [
            'http://127.0.0.1:3000/layerzero/getLayerZeroPacket',
            'http://127.0.0.1:3001/layerzero/getLayerZeroPacket',
          ];
        }
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
        if (variant === LayerZeroV2Variant.Callback) {
          expect(derived.remoteRouters[remote].callbackGasLimit).to.equal(
            333_333n,
          );
        } else {
          expect(derived.urls).to.deep.equal([
            'http://127.0.0.1:3000/layerzero/getLayerZeroPacket',
            'http://127.0.0.1:3001/layerzero/getLayerZeroPacket',
          ]);
        }
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
        expect(derived.remoteRouters[remote].effectiveSendConfig).to.deep.equal(
          {
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
          },
        );
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
        const ism = updatedConfig[chain].interchainSecurityModule;
        assert(
          typeof ism !== 'string' &&
            ism &&
            (ism.type === IsmType.LAYER_ZERO_V2_CALLBACK ||
              ism.type === IsmType.LAYER_ZERO_V2_CCIP_READ),
          `Missing LayerZero ISM on ${chain}`,
        );
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
        const ism = updatedConfig[chain].interchainSecurityModule;
        assert(
          typeof ism !== 'string' &&
            ism &&
            (ism.type === IsmType.LAYER_ZERO_V2_CALLBACK ||
              ism.type === IsmType.LAYER_ZERO_V2_CCIP_READ),
          `Missing LayerZero ISM on ${chain}`,
        );
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
        expect(derived.remoteRouters[remote].effectiveSendConfig).to.deep.equal(
          {
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
          },
        );
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
  }
});
