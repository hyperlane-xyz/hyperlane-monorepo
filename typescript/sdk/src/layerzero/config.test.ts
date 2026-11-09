import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  CombinedHookIsmWarpChainConfig,
  pairCombinedHookIsmConfigs,
} from '../combinedHookIsm/config.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

import {
  LAYER_ZERO_V2_LEAF_MATCHER,
  buildLayerZeroV2MeshConfig,
} from './config.js';
import {
  LayerZeroV2ConfigMode,
  LayerZeroV2MeshConfig,
  LayerZeroV2PathwaySchema,
  findAsymmetricLayerZeroV2Routes,
} from './types.js';

const address = () => ethers.Wallet.createRandom().address;

const defaultSendConfig = () => ({
  executor: { type: LayerZeroV2ConfigMode.Default },
  uln: { type: LayerZeroV2ConfigMode.Default },
});
const defaultReceiveConfig = () => ({
  uln: { type: LayerZeroV2ConfigMode.Default },
});

const URLS = ['https://example.com/layerzero'];

function layerZeroConfig(): Record<string, CombinedHookIsmWarpChainConfig> {
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
          { type: HookType.LAYER_ZERO_V2 },
        ],
      },
      interchainSecurityModule: {
        type: IsmType.LAYER_ZERO_V2,
        owner,
        endpoint: endpointA,
        layerZeroDomainId: 101,
        urls: URLS,
        pathways: {
          chainB: {
            layerZeroDomainId: 102,
            sendLibrary: libraryA,
            receiveLibrary: libraryA,
            sendConfig: defaultSendConfig(),
            receiveConfig: defaultReceiveConfig(),
          },
        },
      },
    },
    chainB: {
      mailbox: address(),
      hook: { type: HookType.LAYER_ZERO_V2 },
      interchainSecurityModule: {
        type: IsmType.LAYER_ZERO_V2,
        owner,
        endpoint: endpointB,
        layerZeroDomainId: 102,
        urls: URLS,
        pathways: {
          chainA: {
            layerZeroDomainId: 101,
            sendLibrary: libraryB,
            receiveLibrary: libraryB,
            sendConfig: defaultSendConfig(),
            receiveConfig: defaultReceiveConfig(),
          },
        },
      },
    },
  };
}

describe('LayerZero V2 warp config', () => {
  it('pairs hook and ISM leaves and builds the complete mesh', () => {
    const config = layerZeroConfig();
    const pairs = pairCombinedHookIsmConfigs(
      LAYER_ZERO_V2_LEAF_MATCHER,
      config,
    );
    const mesh = buildLayerZeroV2MeshConfig(config, pairs);
    expect(Object.keys(pairs)).to.deep.equal(['chainA', 'chainB']);
    expect(mesh.chainA.urls).to.deep.equal(URLS);
    expect(mesh.chainA.remoteRouters.chainB.layerZeroDomainId).to.equal(102);
    expect(mesh.chainA.remoteRouters.chainB.router).to.equal(
      ethers.constants.AddressZero,
    );
  });

  it('canonicalizes and validates typed overrides', () => {
    const lowerDvn = '0x0000000000000000000000000000000000000001';
    const higherDvn = '0x0000000000000000000000000000000000000002';
    const pathway = {
      layerZeroDomainId: 102,
      sendLibrary: address(),
      receiveLibrary: address(),
      sendConfig: {
        executor: {
          type: LayerZeroV2ConfigMode.Override,
          maxMessageSize: 20_000,
        },
        uln: {
          type: LayerZeroV2ConfigMode.Override,
          confirmations: 12,
          requiredDVNs: [higherDvn, lowerDvn],
          optionalDVNs: [],
        },
      },
      receiveConfig: defaultReceiveConfig(),
    };
    const parsed = LayerZeroV2PathwaySchema.parse(pathway);
    expect(parsed.sendConfig.uln).to.include({
      type: LayerZeroV2ConfigMode.Override,
      confirmations: 12n,
    });
    expect(
      parsed.sendConfig.uln.type === LayerZeroV2ConfigMode.Override
        ? parsed.sendConfig.uln.requiredDVNs
        : undefined,
    ).to.deep.equal([lowerDvn, higherDvn]);
    expect(
      parsed.sendConfig.uln.type === LayerZeroV2ConfigMode.Override
        ? parsed.sendConfig.uln.optionalDVNThreshold
        : undefined,
    ).to.equal(0);
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendConfig: {
          ...pathway.sendConfig,
          uln: {
            type: LayerZeroV2ConfigMode.Override,
            requiredDVNs: [lowerDvn, lowerDvn],
          },
        },
      }),
    ).to.throw('Duplicate LayerZero DVN');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        receiveConfig: {
          uln: {
            type: LayerZeroV2ConfigMode.Override,
            optionalDVNs: [lowerDvn],
            optionalDVNThreshold: 2,
          },
        },
      }),
    ).to.throw('between 1 and the DVN count');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        receiveConfig: {
          uln: {
            type: LayerZeroV2ConfigMode.Override,
            requiredDVNs: [],
            optionalDVNs: [],
          },
        },
      }),
    ).to.throw('retain at least one DVN');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendLibrary: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      }),
    ).to.throw('valid EVM address');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendConfig: {
          ...pathway.sendConfig,
          executor: {
            type: LayerZeroV2ConfigMode.Override,
            executor: ethers.constants.AddressZero,
          },
        },
      }),
    ).to.throw('nonzero EVM address');
    expect(() =>
      LayerZeroV2PathwaySchema.parse({
        ...pathway,
        sendConfig: {
          ...pathway.sendConfig,
          executor: {
            type: LayerZeroV2ConfigMode.Default,
            maxMessageSize: 20_000,
          },
        },
      }),
    ).to.throw('Unrecognized key');
  });

  it('materializes omitted pathway defaults', () => {
    const parsed = LayerZeroV2PathwaySchema.parse({
      layerZeroDomainId: 102,
      sendLibrary: address(),
      receiveLibrary: address(),
    });
    expect(parsed.sendConfig).to.deep.equal(defaultSendConfig());
    expect(parsed.receiveConfig).to.deep.equal(defaultReceiveConfig());
  });
});

describe('findAsymmetricLayerZeroV2Routes', () => {
  function mesh(): LayerZeroV2MeshConfig {
    const config = layerZeroConfig();
    return buildLayerZeroV2MeshConfig(
      config,
      pairCombinedHookIsmConfigs(LAYER_ZERO_V2_LEAF_MATCHER, config),
    );
  }

  it('accepts a reciprocal mesh', () => {
    expect(findAsymmetricLayerZeroV2Routes(mesh())).to.deep.equal([]);
  });

  it('reports a one-sided enrollment', () => {
    const oneSided = mesh();
    oneSided.chainB.remoteRouters = {};

    expect(findAsymmetricLayerZeroV2Routes(oneSided)).to.deep.equal([
      'chainB does not enroll chainA',
    ]);
  });
});
