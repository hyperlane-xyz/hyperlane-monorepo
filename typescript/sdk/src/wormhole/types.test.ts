import { expect } from 'chai';

import {
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  WormholeHookIsmConfig,
  WormholeHookIsmSchema,
  WormholeMeshConfig,
  WormholeRemoteRouterSchema,
  WormholeVaaConsistencyLevel,
  findAsymmetricWormholeRoutes,
} from './types.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const MAILBOX = '0x0000000000000000000000000000000000000002';
const CORE = '0x0000000000000000000000000000000000000003';
const ROUTER_A = '0x00000000000000000000000000000000000000aa';
const ROUTER_B = '0x00000000000000000000000000000000000000bb';
const CCL = '0x00000000000000000000000000000000000000cc';

const URLS = ['https://vaa.example/getWormholeVaa'];

function directVaaConfig(
  overrides: Partial<WormholeHookIsmConfig> = {},
): WormholeHookIsmConfig {
  return {
    owner: OWNER,
    mailbox: MAILBOX,
    core: CORE,
    consistencyLevel: { type: WormholeConsistencyType.Finalized },
    urls: URLS,
    remoteRouters: {
      base: {
        router: ROUTER_B,
        wormholeChainId: 30,
        expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
        expectedCustomBaseConsistencyLevel: 0,
        expectedAdditionalBlocks: 0,
      },
    },
    ...overrides,
  };
}

describe('WormholeHookIsmSchema', () => {
  it('accepts a direct-VAA config', () => {
    expect(() => WormholeHookIsmSchema.parse(directVaaConfig())).to.not.throw();
  });

  it('accepts a complete custom consistency-level config', () => {
    expect(() =>
      WormholeHookIsmSchema.parse(
        directVaaConfig({
          consistencyLevel: {
            type: WormholeConsistencyType.Custom,
            address: CCL,
            baseConsistencyLevel: WormholeConsistencyType.Instant,
            additionalBlocks: 2,
          },
        }),
      ),
    ).to.not.throw();
  });

  it('rejects an incomplete custom consistency-level config', () => {
    expect(() =>
      WormholeHookIsmSchema.parse({
        ...directVaaConfig(),
        consistencyLevel: {
          type: WormholeConsistencyType.Custom,
          baseConsistencyLevel: WormholeConsistencyType.Instant,
          additionalBlocks: 2,
        },
      }),
    ).to.throw();
  });

  it('rejects a custom consistency level with zero additional blocks', () => {
    expect(() =>
      WormholeHookIsmSchema.parse(
        directVaaConfig({
          consistencyLevel: {
            type: WormholeConsistencyType.Custom,
            address: CCL,
            baseConsistencyLevel: WormholeConsistencyType.Instant,
            additionalBlocks: 0,
          },
        }),
      ),
    ).to.throw(/additionalBlocks/);
  });

  const remoteExpectedLevels: WormholeVaaConsistencyLevel[] = [0, 1, 32];
  for (const expectedConsistencyLevel of remoteExpectedLevels) {
    it(`accepts a remote router expected at consistency ${expectedConsistencyLevel}`, () => {
      const config = WormholeHookIsmSchema.parse(
        directVaaConfig({
          remoteRouters: {
            base: {
              router: ROUTER_B,
              wormholeChainId: 30,
              expectedConsistencyLevel,
              expectedCustomBaseConsistencyLevel: 0,
              expectedAdditionalBlocks: 0,
            },
          },
        }),
      );

      expect(config.remoteRouters.base.expectedConsistencyLevel).to.equal(
        expectedConsistencyLevel,
      );
    });
  }

  it('rejects a remote router expected at an unsupported consistency', () => {
    expect(() =>
      WormholeRemoteRouterSchema.parse({
        router: ROUTER_B,
        wormholeChainId: 30,
        expectedConsistencyLevel: 2,
        expectedCustomBaseConsistencyLevel: 0,
        expectedAdditionalBlocks: 0,
      }),
    ).to.throw(/expectedConsistencyLevel/);
  });

  it('requires urls', () => {
    const config: Partial<WormholeHookIsmConfig> = directVaaConfig();
    delete config.urls;

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(/urls/);
  });

  it('rejects two Hyperlane domains claiming one Wormhole chain ID', () => {
    const config = directVaaConfig({
      remoteRouters: {
        base: {
          router: ROUTER_B,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
        optimism: {
          router: ROUTER_A,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
      },
    });

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /already claimed by base/,
    );
  });
});

describe('findAsymmetricWormholeRoutes', () => {
  function mesh(): WormholeMeshConfig {
    return {
      ethereum: directVaaConfig({
        remoteRouters: {
          base: {
            router: ROUTER_B,
            wormholeChainId: 30,
            expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
            expectedCustomBaseConsistencyLevel: 0,
            expectedAdditionalBlocks: 0,
          },
        },
      }),
      base: directVaaConfig({
        remoteRouters: {
          ethereum: {
            router: ROUTER_A,
            wormholeChainId: 2,
            expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
            expectedCustomBaseConsistencyLevel: 0,
            expectedAdditionalBlocks: 0,
          },
        },
      }),
    };
  }

  it('accepts a reciprocal mesh', () => {
    expect(findAsymmetricWormholeRoutes(mesh())).to.deep.equal([]);
  });

  it('reports a one-sided enrollment', () => {
    const oneSided = mesh();
    oneSided.base.remoteRouters = {};

    expect(findAsymmetricWormholeRoutes(oneSided)).to.deep.equal([
      'base does not enroll ethereum',
      'base does not enroll ethereum',
    ]);
  });

  it('reports a consistency-level mismatch against what the origin publishes', () => {
    const mismatched = mesh();
    mismatched.ethereum.remoteRouters.base.expectedConsistencyLevel =
      WormholeConsistencyLevel.Safe;

    expect(findAsymmetricWormholeRoutes(mismatched)).to.deep.equal([
      'ethereum expects consistency 201 from base, which publishes at 202',
    ]);
  });

  it('accepts a peer that publishes at zero finalized when expected at 0', () => {
    const zeroFinalized = mesh();
    zeroFinalized.base.consistencyLevel = {
      type: WormholeConsistencyType.ZeroFinalized,
    };
    zeroFinalized.ethereum.remoteRouters.base.expectedConsistencyLevel = 0;

    expect(findAsymmetricWormholeRoutes(zeroFinalized)).to.deep.equal([]);
  });

  it('reports a guardian-finalized expectation from a zero-finalized peer', () => {
    const mismatched = mesh();
    mismatched.base.consistencyLevel = {
      type: WormholeConsistencyType.ZeroFinalized,
    };

    expect(findAsymmetricWormholeRoutes(mismatched)).to.deep.equal([
      'ethereum expects consistency 202 from base, which publishes at 0',
    ]);
  });

  it('reports a custom consistency mismatch against what the origin publishes', () => {
    const mismatched = mesh();
    mismatched.base.consistencyLevel = {
      type: WormholeConsistencyType.Custom,
      address: CCL,
      baseConsistencyLevel: WormholeConsistencyType.Safe,
      additionalBlocks: 5,
    };
    mismatched.ethereum.remoteRouters.base.expectedConsistencyLevel =
      WormholeConsistencyLevel.Custom;
    mismatched.ethereum.remoteRouters.base.expectedCustomBaseConsistencyLevel =
      WormholeConsistencyLevel.Instant;
    mismatched.ethereum.remoteRouters.base.expectedAdditionalBlocks = 5;

    expect(findAsymmetricWormholeRoutes(mismatched)).to.deep.equal([
      'ethereum expects custom consistency 200+5 from base, which publishes at 201+5',
    ]);
  });
});
