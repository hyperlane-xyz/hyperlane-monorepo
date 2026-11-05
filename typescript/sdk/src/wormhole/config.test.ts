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
  type WormholeConsistencyLevelConfig,
  WormholeConsistencyType,
} from './types.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const MAILBOX = '0x0000000000000000000000000000000000000002';
const CORE = '0x0000000000000000000000000000000000000003';
const CCL = '0x0000000000000000000000000000000000000004';
const URLS = ['https://example.com/{data}'];
const BASE_ROUTER = '0x00000000000000000000000000000000000000ba';
const OPTIMISM_ROUTER = '0x00000000000000000000000000000000000000b0';

function wormholeHook(): HookConfig {
  return { type: HookType.WORMHOLE_VAA };
}

function wormholeIsm(
  wormholeChainId: number,
  consistencyLevel: WormholeConsistencyLevelConfig = {
    type: WormholeConsistencyType.Finalized,
  },
): IsmConfig {
  return {
    type: IsmType.WORMHOLE_VAA,
    owner: OWNER,
    core: CORE,
    wormholeChainId,
    consistencyLevel,
    urls: URLS,
  };
}

function wormholeRoute(): Record<string, WormholeWarpChainConfig> {
  return {
    base: {
      mailbox: MAILBOX,
      hook: {
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MAILBOX_DEFAULT }, wormholeHook()],
      },
      interchainSecurityModule: {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [{ type: IsmType.TEST_ISM }, wormholeIsm(30)],
      },
    },
    optimism: {
      mailbox: MAILBOX,
      hook: wormholeHook(),
      interchainSecurityModule: wormholeIsm(24, {
        type: WormholeConsistencyType.Custom,
        address: CCL,
        baseConsistencyLevel: WormholeConsistencyType.Safe,
        additionalBlocks: 3,
      }),
    },
  };
}

describe('Wormhole Warp config resolution', () => {
  it('pairs nested hook and ISM leaves and derives the mesh', () => {
    const config = wormholeRoute();
    const pairs = pairWormholeConfigs(config);
    const mesh = buildWormholeMeshConfig(config, pairs);

    expect(mesh.base.remoteRouters.optimism).to.include({
      wormholeChainId: 24,
      expectedConsistencyLevel: WormholeConsistencyLevel.Custom,
      expectedCustomBaseConsistencyLevel: WormholeConsistencyLevel.Safe,
      expectedAdditionalBlocks: 3,
    });
    expect(mesh.optimism.remoteRouters.base).to.include({
      wormholeChainId: 30,
      expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
      expectedCustomBaseConsistencyLevel: 0,
      expectedAdditionalBlocks: 0,
    });
    expect(mesh.base.urls).to.deep.equal(URLS);
  });

  it('replaces both leaves with the same local address', () => {
    const resolved = materializeWormholeWarpConfig(wormholeRoute(), {
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
    const config = wormholeRoute();
    delete config.base.hook;

    expect(() => pairWormholeConfigs(config)).to.throw(
      'base must contain exactly one Wormhole hook leaf; found 0',
    );
  });

  it('rejects duplicate Wormhole leaves', () => {
    const config = wormholeRoute();
    config.base.hook = {
      type: HookType.AGGREGATION,
      hooks: [wormholeHook(), wormholeHook()],
    };

    expect(() => pairWormholeConfigs(config)).to.throw(
      'base must contain exactly one Wormhole hook leaf; found 2',
    );
  });

  it('rejects a directional pairing mismatch', () => {
    const config = wormholeRoute();
    config.base.hook = {
      type: HookType.ROUTING,
      owner: OWNER,
      domains: { base: wormholeHook() },
    };

    expect(() => pairWormholeConfigs(config)).to.throw(
      /Wormhole pairing mismatch for base -> optimism/,
    );
  });
});
