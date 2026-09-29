import { expect } from 'chai';

import {
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  WormholeHookIsmConfig,
  WormholeHookIsmSchema,
  WormholeMeshConfig,
  WormholeVariant,
  findAsymmetricWormholeRoutes,
} from './types.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const MAILBOX = '0x0000000000000000000000000000000000000002';
const CORE = '0x0000000000000000000000000000000000000003';
const QUOTER_ROUTER = '0x0000000000000000000000000000000000000004';
const QUOTER = '0x0000000000000000000000000000000000000005';
const ROUTER_A = '0x00000000000000000000000000000000000000aa';
const ROUTER_B = '0x00000000000000000000000000000000000000bb';
const CCL = '0x00000000000000000000000000000000000000cc';

const URLS = ['https://vaa.example/getWormholeVaa'];

function directVaaConfig(
  overrides: Partial<WormholeHookIsmConfig> = {},
): WormholeHookIsmConfig {
  return {
    type: WormholeVariant.DirectVaa,
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
      },
    },
    ...overrides,
  };
}

function executorConfig(
  overrides: Partial<WormholeHookIsmConfig> = {},
): WormholeHookIsmConfig {
  return {
    type: WormholeVariant.Executor,
    owner: OWNER,
    mailbox: MAILBOX,
    core: CORE,
    consistencyLevel: { type: WormholeConsistencyType.Finalized },
    executorQuoterRouter: QUOTER_ROUTER,
    remoteRouters: {
      base: {
        router: ROUTER_B,
        wormholeChainId: 30,
        expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
        quoter: QUOTER,
        callbackGasLimit: 300_000n,
      },
    },
    ...overrides,
  };
}

describe('WormholeHookIsmSchema', () => {
  it('accepts a direct-VAA config', () => {
    expect(() => WormholeHookIsmSchema.parse(directVaaConfig())).to.not.throw();
  });

  it('accepts an Executor config', () => {
    expect(() => WormholeHookIsmSchema.parse(executorConfig())).to.not.throw();
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

  it('requires urls for direct VAA', () => {
    const config = directVaaConfig();
    delete config.urls;

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /wormholeVaa requires urls/,
    );
  });

  it('rejects Executor fields on a direct-VAA config', () => {
    const config = directVaaConfig({ executorQuoterRouter: QUOTER_ROUTER });

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /executorQuoterRouter is a wormholeExecutor field/,
    );
  });

  it('rejects per-route Executor fields on a direct-VAA config', () => {
    const config = directVaaConfig({
      remoteRouters: {
        base: {
          router: ROUTER_B,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          quoter: QUOTER,
        },
      },
    });

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /quoter and callbackGasLimit are wormholeExecutor fields/,
    );
  });

  it('requires the Quoter Router for Executor', () => {
    const config = executorConfig();
    delete config.executorQuoterRouter;

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /wormholeExecutor requires executorQuoterRouter/,
    );
  });

  it('requires a quoter on every Executor route', () => {
    const config = executorConfig({
      remoteRouters: {
        base: {
          router: ROUTER_B,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          callbackGasLimit: 300_000n,
        },
      },
    });

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /requires a quoter for every route/,
    );
  });

  it('rejects a zero callback gas limit', () => {
    const config = executorConfig({
      remoteRouters: {
        base: {
          router: ROUTER_B,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          quoter: QUOTER,
          callbackGasLimit: 0n,
        },
      },
    });

    expect(() => WormholeHookIsmSchema.parse(config)).to.throw(
      /nonzero callbackGasLimit/,
    );
  });

  it('rejects two Hyperlane domains claiming one Wormhole chain ID', () => {
    const config = directVaaConfig({
      remoteRouters: {
        base: {
          router: ROUTER_B,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
        },
        optimism: {
          router: ROUTER_A,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
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
          },
        },
      }),
      base: directVaaConfig({
        remoteRouters: {
          ethereum: {
            router: ROUTER_A,
            wormholeChainId: 2,
            expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
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

  it('reports a variant mismatch across the mesh', () => {
    const mixed = mesh();
    mixed.base = executorConfig({
      remoteRouters: {
        ethereum: {
          router: ROUTER_A,
          wormholeChainId: 2,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          quoter: QUOTER,
          callbackGasLimit: 300_000n,
        },
      },
    });

    expect(findAsymmetricWormholeRoutes(mixed)).to.deep.equal([
      'ethereum is wormholeVaa but base is wormholeExecutor',
      'base is wormholeExecutor but ethereum is wormholeVaa',
    ]);
  });
});
