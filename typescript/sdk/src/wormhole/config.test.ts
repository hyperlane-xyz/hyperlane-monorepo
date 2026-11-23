import { expect } from 'chai';
import { assert } from '@hyperlane-xyz/utils';

import { HookConfig, HookType } from '../hook/types.js';
import {
  collapseMatchingCombinedHookIsmNodes,
  resolveCombinedHookIsmNodesToAddress,
} from '../hook/utils.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import {
  collapseMatchingCombinedHookIsmNodes as collapseCombinedIsm,
  resolveCombinedHookIsmNodesToAddress as resolveCombinedIsm,
} from '../utils/ism.js';

import {
  CombinedHookIsmWarpChainConfig,
  pairCombinedHookIsmConfigs,
} from '../combinedHookIsm/config.js';

import { WORMHOLE_LEAF_MATCHER, buildWormholeMeshConfig } from './config.js';
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

function wormholeHook(): HookConfig {
  return { type: HookType.WORMHOLE };
}

function wormholeIsm(
  wormholeChainId: number,
  consistencyLevel: WormholeConsistencyLevelConfig = {
    type: WormholeConsistencyType.Finalized,
  },
): IsmConfig {
  return {
    type: IsmType.WORMHOLE,
    owner: OWNER,
    core: CORE,
    wormholeChainId,
    consistencyLevel,
    urls: URLS,
  };
}

function wormholeRoute(): Record<string, CombinedHookIsmWarpChainConfig> {
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
  it('treats Wormhole leaves as generic opaque combined hook/ISM nodes', () => {
    const config = wormholeRoute();
    const sharedAddress = '0x00000000000000000000000000000000000000aa';
    const { hook: baseHook, interchainSecurityModule: baseIsm } = config.base;
    assert(baseHook && baseIsm, 'Expected base hook and ISM configs');
    const hook = resolveCombinedHookIsmNodesToAddress(baseHook, sharedAddress);
    const ism = resolveCombinedIsm(baseIsm, sharedAddress);

    expect(hook).to.deep.include({
      hooks: [{ type: HookType.MAILBOX_DEFAULT }, sharedAddress],
    });
    expect(ism).to.deep.include({
      modules: [{ type: IsmType.TEST_ISM }, sharedAddress],
    });

    expect(
      collapseMatchingCombinedHookIsmNodes(hook, sharedAddress),
    ).to.deep.equal(hook);
    expect(collapseCombinedIsm(ism, sharedAddress)).to.deep.equal(ism);
  });

  it('pairs nested hook and ISM leaves and derives the mesh', () => {
    const config = wormholeRoute();
    const pairs = pairCombinedHookIsmConfigs(WORMHOLE_LEAF_MATCHER, config);
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
});
