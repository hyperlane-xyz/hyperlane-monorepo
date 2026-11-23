import { constants } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  CombinedHookIsmConfigPair,
  CombinedHookIsmLeafMatcher,
  CombinedHookIsmWarpChainConfig,
} from '../combinedHookIsm/config.js';
import { HookConfig, HookType, WormholeHookConfig } from '../hook/types.js';
import { IsmConfig, IsmType, WormholeIsmConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';

import { WormholeHookIsmConfig, WormholeMeshConfig } from './types.js';
import { consistencyLevelConfigToOnchain } from './consistency.js';

function isWormholeHook(
  config: HookConfig | undefined,
): config is WormholeHookConfig {
  return (
    !!config && typeof config !== 'string' && config.type === HookType.WORMHOLE
  );
}

function isWormholeIsm(config: IsmConfig): config is WormholeIsmConfig {
  return typeof config !== 'string' && config.type === IsmType.WORMHOLE;
}

export const WORMHOLE_LEAF_MATCHER: CombinedHookIsmLeafMatcher<
  WormholeHookConfig,
  WormholeIsmConfig
> = {
  label: 'Wormhole',
  isHook: isWormholeHook,
  isIsm: isWormholeIsm,
};

export function buildWormholeMeshConfig(
  configs: ChainMap<CombinedHookIsmWarpChainConfig>,
  pairs: ChainMap<
    CombinedHookIsmConfigPair<WormholeHookConfig, WormholeIsmConfig>
  >,
): WormholeMeshConfig {
  const chains = Object.keys(pairs);
  return Object.fromEntries(
    chains.map((chain) => {
      const local = pairs[chain];
      const mailbox = configs[chain].mailbox;
      assert(mailbox, `${chain} requires a mailbox for Wormhole deployment`);

      const remoteRouters = Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => {
            const remoteIsm = pairs[remote].ism;
            const remoteConsistency = consistencyLevelConfigToOnchain(
              remoteIsm.consistencyLevel,
            );
            return [
              remote,
              {
                router: constants.AddressZero,
                wormholeChainId: remoteIsm.wormholeChainId,
                expectedConsistencyLevel: remoteConsistency.consistencyLevel,
                expectedCustomBaseConsistencyLevel:
                  remoteConsistency.customBaseConsistencyLevel,
                expectedAdditionalBlocks: remoteConsistency.additionalBlocks,
              },
            ];
          }),
      );

      const common: WormholeHookIsmConfig = {
        owner: local.ism.owner,
        mailbox,
        core: local.ism.core,
        wormholeChainId: local.ism.wormholeChainId,
        consistencyLevel: local.ism.consistencyLevel,
        urls: local.ism.urls,
        remoteRouters,
      };
      return [chain, common];
    }),
  );
}
