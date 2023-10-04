import { ChainMap } from '@hyperlane-xyz/sdk';
import {
  AggregationHookConfig,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/sdk/dist/hook/types';
import { HookType } from '@hyperlane-xyz/sdk/src/hook/types';
import { objMap } from '@hyperlane-xyz/utils';

import { igp } from './igp';
import { owners } from './owners';

export const merkleTree: ChainMap<MerkleTreeHookConfig> = objMap(
  owners,
  (_, __) => {
    const config: MerkleTreeHookConfig = {
      type: HookType.MERKLE_TREE_HOOK,
    };
    return config;
  },
);

export const aggregation: ChainMap<AggregationHookConfig> = objMap(
  owners,
  (chain, __) => {
    const config: AggregationHookConfig = {
      type: HookType.AGGREGATION,
      modules: [{ type: HookType.IGP, ...igp[chain] }, merkleTree[chain]],
    };
    return config;
  },
);
