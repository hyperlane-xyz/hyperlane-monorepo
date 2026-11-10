import { constants } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  CombinedHookIsmConfigPair,
  CombinedHookIsmLeafMatcher,
  CombinedHookIsmWarpChainConfig,
} from '../combinedHookIsm/config.js';
import { HookConfig, HookType, LayerZeroV2HookConfig } from '../hook/types.js';
import { IsmConfig, IsmType, LayerZeroV2IsmConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';

import { LayerZeroV2HookIsmConfig, LayerZeroV2MeshConfig } from './types.js';

function isLayerZeroV2Hook(
  config: HookConfig | undefined,
): config is LayerZeroV2HookConfig {
  return (
    !!config &&
    typeof config !== 'string' &&
    config.type === HookType.LAYER_ZERO_V2
  );
}

export function isLayerZeroV2Ism(
  config: IsmConfig,
): config is LayerZeroV2IsmConfig {
  return typeof config !== 'string' && config.type === IsmType.LAYER_ZERO_V2;
}

export const LAYER_ZERO_V2_LEAF_MATCHER: CombinedHookIsmLeafMatcher<
  LayerZeroV2HookConfig,
  LayerZeroV2IsmConfig
> = {
  label: 'LayerZero',
  isHook: isLayerZeroV2Hook,
  isIsm: isLayerZeroV2Ism,
};

export function buildLayerZeroV2MeshConfig(
  configs: ChainMap<CombinedHookIsmWarpChainConfig>,
  pairs: ChainMap<
    CombinedHookIsmConfigPair<LayerZeroV2HookConfig, LayerZeroV2IsmConfig>
  >,
): LayerZeroV2MeshConfig {
  const chains = Object.keys(pairs);
  return Object.fromEntries(
    chains.map((chain) => {
      const local = pairs[chain];
      const mailbox = configs[chain].mailbox;
      assert(mailbox, `${chain} requires a mailbox for LayerZero deployment`);
      const remoteRouters = Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => {
            const pathway = local.ism.pathways[remote];
            assert(pathway, `${chain} has no LayerZero pathway for ${remote}`);
            return [
              remote,
              {
                ...pathway,
                router: constants.AddressZero,
              },
            ];
          }),
      );
      const config: LayerZeroV2HookIsmConfig = {
        owner: local.ism.owner,
        mailbox,
        endpoint: local.ism.endpoint,
        layerZeroDomainId: local.ism.layerZeroDomainId,
        urls: local.ism.urls,
        remoteRouters,
      };
      return [chain, config];
    }),
  );
}
