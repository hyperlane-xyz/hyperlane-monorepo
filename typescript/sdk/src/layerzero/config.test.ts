import { expect } from 'chai';
import { ethers } from 'ethers';

import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

import {
  LayerZeroV2WarpChainConfig,
  buildLayerZeroV2MeshConfig,
  materializeLayerZeroV2WarpConfig,
  pairLayerZeroV2Configs,
} from './config.js';
import { LayerZeroV2PathwaySchema, LayerZeroV2Variant } from './types.js';

const address = () => ethers.Wallet.createRandom().address;

function callbackConfig(): Record<string, LayerZeroV2WarpChainConfig> {
  const endpointA = address();
  const endpointB = address();
  const libraryA = address();
  const libraryB = address();
  const owner = address();
  return {
    chainA: {
      mailbox: address(),
      hook: {
        type: HookType.AGGREGATION,
        hooks: [
          { type: HookType.MAILBOX_DEFAULT },
          {
            type: HookType.LAYER_ZERO_V2_CALLBACK,
            callbackGasLimits: { chainB: 250_000n },
          },
        ],
      },
      interchainSecurityModule: {
        type: IsmType.LAYER_ZERO_V2_CALLBACK,
        owner,
        endpoint: endpointA,
        layerZeroDomainId: 101,
        pathways: {
          chainB: {
            layerZeroDomainId: 102,
            sendLibrary: libraryA,
            receiveLibrary: libraryA,
            receiveLibraryGracePeriod: 0,
            sendConfig: [],
            receiveConfig: [],
          },
        },
      },
    },
    chainB: {
      mailbox: address(),
      hook: {
        type: HookType.LAYER_ZERO_V2_CALLBACK,
        callbackGasLimits: { chainA: 300_000n },
      },
      interchainSecurityModule: {
        type: IsmType.LAYER_ZERO_V2_CALLBACK,
        owner,
        endpoint: endpointB,
        layerZeroDomainId: 102,
        pathways: {
          chainA: {
            layerZeroDomainId: 101,
            sendLibrary: libraryB,
            receiveLibrary: libraryB,
            receiveLibraryGracePeriod: 0,
            sendConfig: [],
            receiveConfig: [],
          },
        },
      },
    },
  };
}

describe('LayerZero V2 warp config', () => {
  it('pairs callback leaves and builds the complete mesh', () => {
    const config = callbackConfig();
    const pairs = pairLayerZeroV2Configs(config);
    const mesh = buildLayerZeroV2MeshConfig(config, pairs);
    expect(Object.keys(pairs)).to.deep.equal(['chainA', 'chainB']);
    expect(mesh.chainA.type).to.equal(LayerZeroV2Variant.Callback);
    expect(mesh.chainA.remoteRouters.chainB.callbackGasLimit).to.equal(
      250_000n,
    );
  });

  it('replaces both tree leaves with one deployed address', () => {
    const config = callbackConfig();
    const deployed = address();
    const result = materializeLayerZeroV2WarpConfig(config, {
      chainA: deployed,
    });
    expect(result.chainA.interchainSecurityModule).to.equal(deployed);
    const hook = result.chainA.hook;
    expect(typeof hook).not.to.equal('string');
    if (typeof hook !== 'string' && hook?.type === HookType.AGGREGATION) {
      expect(hook.hooks).to.include(deployed);
    }
  });

  it('rejects pull mode when nested in an aggregation ISM', () => {
    const config = callbackConfig();
    config.chainA.hook = { type: HookType.LAYER_ZERO_V2_CCIP_READ };
    config.chainA.interchainSecurityModule = {
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [
        {
          type: IsmType.LAYER_ZERO_V2_CCIP_READ,
          owner: address(),
          endpoint: address(),
          urls: ['https://example.com/layerzero'],
          pathways: {
            chainB: {
              layerZeroDomainId: 102,
              sendLibrary: address(),
              receiveLibrary: address(),
              receiveLibraryGracePeriod: 0,
              sendConfig: [],
              receiveConfig: [],
            },
          },
        },
      ],
    };
    expect(() => pairLayerZeroV2Configs(config)).to.throw(
      'must be direct and standalone',
    );
  });

  it('canonicalizes and validates Endpoint config types', () => {
    const pathway = {
      layerZeroDomainId: 102,
      sendLibrary: address(),
      receiveLibrary: address(),
      receiveLibraryGracePeriod: 0,
      sendConfig: [
        { configType: 2, config: '0x1234' },
        { configType: 1, config: '0xabcd' },
      ],
      receiveConfig: [],
    };
    const parsed = LayerZeroV2PathwaySchema.parse(pathway);
    expect(parsed.sendConfig.map(({ configType }) => configType)).to.deep.equal(
      [1, 2],
    );
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendConfig: [
          { configType: 2, config: '0x1234' },
          { configType: 2, config: '0xabcd' },
        ],
      }),
    ).to.throw('Duplicate LayerZero config type 2');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        receiveConfig: [{ configType: 1, config: '0x1234' }],
      }),
    ).to.throw('receive config only supports ULN config type 2');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendLibrary: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      }),
    ).to.throw('valid EVM address');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendConfig: [{ configType: 1, config: '0x' }],
      }),
    ).to.throw();
  });

  it('materializes omitted pathway defaults', () => {
    const parsed = LayerZeroV2PathwaySchema.parse({
      layerZeroDomainId: 102,
      sendLibrary: address(),
      receiveLibrary: address(),
    });
    expect(parsed.receiveLibraryGracePeriod).to.equal(0);
    expect(parsed.sendConfig).to.deep.equal([]);
    expect(parsed.receiveConfig).to.deep.equal([]);
  });
});
