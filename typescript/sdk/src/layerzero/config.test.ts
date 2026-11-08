import { expect } from 'chai';
import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

import {
  LayerZeroV2WarpChainConfig,
  buildLayerZeroV2MeshConfig,
  materializeLayerZeroV2WarpConfig,
  pairLayerZeroV2Configs,
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

function layerZeroConfig(): Record<string, LayerZeroV2WarpChainConfig> {
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
    const pairs = pairLayerZeroV2Configs(config);
    const mesh = buildLayerZeroV2MeshConfig(config, pairs);
    expect(Object.keys(pairs)).to.deep.equal(['chainA', 'chainB']);
    expect(mesh.chainA.urls).to.deep.equal(URLS);
    expect(mesh.chainA.remoteRouters.chainB.layerZeroDomainId).to.equal(102);
    expect(mesh.chainA.remoteRouters.chainB.router).to.equal(
      ethers.constants.AddressZero,
    );
  });

  it('replaces both tree leaves with one deployed address', () => {
    const config = layerZeroConfig();
    const deployed = address();
    const result = materializeLayerZeroV2WarpConfig(config, {
      chainA: deployed,
      chainB: address(),
    });
    expect(result.chainA.interchainSecurityModule).to.equal(deployed);
    const hook = result.chainA.hook;
    expect(typeof hook).not.to.equal('string');
    if (typeof hook !== 'string' && hook?.type === HookType.AGGREGATION) {
      expect(hook.hooks).to.include(deployed);
    }
  });

  it('requires a deployed address for every chain', () => {
    expect(() =>
      materializeLayerZeroV2WarpConfig(layerZeroConfig(), {
        chainA: address(),
      }),
    ).to.throw('Missing deployed LayerZero router for chainB');
  });

  it('requires both leaves on every participating chain', () => {
    const config = layerZeroConfig();
    delete config.chainA.hook;

    expect(() => pairLayerZeroV2Configs(config)).to.throw(
      'chainA must contain exactly one LayerZero hook leaf; found 0',
    );
  });

  it('rejects duplicate LayerZero leaves', () => {
    const config = layerZeroConfig();
    config.chainA.hook = {
      type: HookType.AGGREGATION,
      hooks: [
        { type: HookType.LAYER_ZERO_V2 },
        { type: HookType.LAYER_ZERO_V2 },
      ],
    };

    expect(() => pairLayerZeroV2Configs(config)).to.throw(
      'chainA must contain exactly one LayerZero hook leaf; found 2',
    );
  });

  it('rejects a directional pairing mismatch', () => {
    const config = layerZeroConfig();
    config.chainA.hook = {
      type: HookType.ROUTING,
      owner: address(),
      domains: { chainA: { type: HookType.LAYER_ZERO_V2 } },
    };

    expect(() => pairLayerZeroV2Configs(config)).to.throw(
      /LayerZero pairing mismatch for chainA -> chainB/,
    );
  });

  interface NestedIsmCase {
    name: string;
    wrap: (
      ism: NonNullable<LayerZeroV2WarpChainConfig['interchainSecurityModule']>,
    ) => NonNullable<LayerZeroV2WarpChainConfig['interchainSecurityModule']>;
  }

  const nestedCases: NestedIsmCase[] = [
    {
      name: 'an aggregation ISM',
      wrap: (ism) => ({
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [ism],
      }),
    },
    {
      name: 'a routing ISM',
      wrap: (ism) => ({
        type: IsmType.ROUTING,
        owner: address(),
        domains: { chainB: ism },
      }),
    },
  ];

  for (const { name, wrap } of nestedCases) {
    it(`pairs a LayerZero ISM nested in ${name}`, () => {
      const config = layerZeroConfig();
      const ism = config.chainA.interchainSecurityModule;
      assert(ism, 'Missing chainA LayerZero ISM');
      config.chainA.interchainSecurityModule = wrap(ism);

      const pairs = pairLayerZeroV2Configs(config);

      expect(pairs.chainA.ism).to.equal(ism);
      const deployed = address();
      const result = materializeLayerZeroV2WarpConfig(config, {
        chainA: deployed,
        chainB: address(),
      });
      expect(JSON.stringify(result.chainA.interchainSecurityModule)).to.include(
        deployed,
      );
    });
  }

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
    return buildLayerZeroV2MeshConfig(config, pairLayerZeroV2Configs(config));
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
