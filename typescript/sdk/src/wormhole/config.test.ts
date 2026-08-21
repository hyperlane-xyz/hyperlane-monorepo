import { expect } from 'chai';
import { assert } from '@hyperlane-xyz/utils';

import { HookConfig, HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';

import {
  WormholeWarpChainConfig,
  buildWormholeMeshConfig,
  materializeWormholeWarpConfig,
  pairWormholeConfigs,
} from './config.js';
import {
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  WormholeVariant,
} from './types.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const MAILBOX = '0x0000000000000000000000000000000000000002';
const CORE = '0x0000000000000000000000000000000000000003';
const QUOTER_ROUTER = '0x0000000000000000000000000000000000000004';
const QUOTER = '0x0000000000000000000000000000000000000005';
const BASE_ROUTER = '0x00000000000000000000000000000000000000ba';
const OPTIMISM_ROUTER = '0x00000000000000000000000000000000000000b0';

function executorHook(remote: string): HookConfig {
  return {
    type: HookType.WORMHOLE_EXECUTOR,
    executorQuoterRouter: QUOTER_ROUTER,
    routes: {
      [remote]: { quoter: QUOTER, callbackGasLimit: 300_000n },
    },
  };
}

function executorIsm(wormholeChainId: number): IsmConfig {
  return {
    type: IsmType.WORMHOLE_EXECUTOR,
    owner: OWNER,
    core: CORE,
    wormholeChainId,
    consistencyLevel: { type: WormholeConsistencyType.Finalized },
  };
}

function executorRoute(): Record<string, WormholeWarpChainConfig> {
  return {
    base: {
      mailbox: MAILBOX,
      hook: {
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MAILBOX_DEFAULT }, executorHook('optimism')],
      },
      interchainSecurityModule: {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [{ type: IsmType.TEST_ISM }, executorIsm(30)],
      },
    },
    optimism: {
      mailbox: MAILBOX,
      hook: executorHook('base'),
      interchainSecurityModule: executorIsm(24),
    },
  };
}

describe('Wormhole Warp config resolution', () => {
  it('pairs nested hook and ISM leaves and derives the mesh', () => {
    const config = executorRoute();
    const pairs = pairWormholeConfigs(config);
    const mesh = buildWormholeMeshConfig(config, pairs);

    expect(pairs.base.variant).to.equal(WormholeVariant.Executor);
    expect(mesh.base.remoteRouters.optimism).to.include({
      wormholeChainId: 24,
      expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
      quoter: QUOTER,
      callbackGasLimit: 300_000n,
    });
    expect(mesh.optimism.remoteRouters.base.wormholeChainId).to.equal(30);
  });

  it('replaces both leaves with the same local address', () => {
    const resolved = materializeWormholeWarpConfig(executorRoute(), {
      base: BASE_ROUTER,
      optimism: OPTIMISM_ROUTER,
    });

    const baseHook = resolved.base.hook;
    const baseIsm = resolved.base.interchainSecurityModule;
    assert(
      typeof baseHook !== 'string' && baseHook.type === HookType.AGGREGATION,
      'Expected aggregation hook',
    );
    assert(
      typeof baseIsm !== 'string' && baseIsm.type === IsmType.AGGREGATION,
      'Expected aggregation ISM',
    );
    expect(baseHook.hooks[0]).to.deep.equal({
      type: HookType.MAILBOX_DEFAULT,
    });
    expect(baseHook.hooks[1]).to.equal(BASE_ROUTER);
    expect(baseIsm.modules[1]).to.equal(BASE_ROUTER);
    expect(resolved.optimism.hook).to.equal(OPTIMISM_ROUTER);
    expect(resolved.optimism.interchainSecurityModule).to.equal(
      OPTIMISM_ROUTER,
    );
  });

  it('requires both leaves on every participating chain', () => {
    const config = executorRoute();
    delete config.base.hook;

    expect(() => pairWormholeConfigs(config)).to.throw(
      'base must contain exactly one Wormhole hook leaf; found 0',
    );
  });

  it('rejects duplicate Wormhole leaves', () => {
    const config = executorRoute();
    config.base.hook = {
      type: HookType.AGGREGATION,
      hooks: [executorHook('optimism'), executorHook('optimism')],
    };

    expect(() => pairWormholeConfigs(config)).to.throw(
      'base must contain exactly one Wormhole hook leaf; found 2',
    );
  });

  it('rejects a hook/ISM variant mismatch', () => {
    const config = executorRoute();
    config.base.hook = { type: HookType.WORMHOLE_VAA };

    expect(() => pairWormholeConfigs(config)).to.throw(
      /base Wormhole hook is wormholeVaa but ISM is wormholeExecutor/,
    );
  });

  it('rejects a directional pairing mismatch', () => {
    const config = executorRoute();
    config.base.hook = {
      type: HookType.ROUTING,
      owner: OWNER,
      domains: { base: executorHook('optimism') },
    };

    expect(() => pairWormholeConfigs(config)).to.throw(
      /Wormhole pairing mismatch for base -> optimism/,
    );
  });

  it('supports the direct-VAA pair without Executor fields', () => {
    const config: Record<string, WormholeWarpChainConfig> = {
      base: {
        mailbox: MAILBOX,
        hook: { type: HookType.WORMHOLE_VAA },
        interchainSecurityModule: {
          type: IsmType.WORMHOLE_VAA,
          owner: OWNER,
          core: CORE,
          wormholeChainId: 30,
          consistencyLevel: { type: WormholeConsistencyType.Finalized },
          urls: ['https://example.com/{data}'],
        },
      },
      optimism: {
        mailbox: MAILBOX,
        hook: { type: HookType.WORMHOLE_VAA },
        interchainSecurityModule: {
          type: IsmType.WORMHOLE_VAA,
          owner: OWNER,
          core: CORE,
          wormholeChainId: 24,
          consistencyLevel: { type: WormholeConsistencyType.Finalized },
          urls: ['https://example.com/{data}'],
        },
      },
    };

    const mesh = buildWormholeMeshConfig(config, pairWormholeConfigs(config));
    expect(mesh.base.type).to.equal(WormholeVariant.DirectVaa);
    expect(mesh.base.executorQuoterRouter).to.equal(undefined);
    expect(mesh.base.urls).to.deep.equal(['https://example.com/{data}']);
  });
});
