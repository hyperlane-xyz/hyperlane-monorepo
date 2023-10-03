import { ChainMap } from '@hyperlane-xyz/sdk';
import { MerkleTreeHookConfig } from '@hyperlane-xyz/sdk/dist/hook/types';
import { HookType } from '@hyperlane-xyz/sdk/src/hook/types';
import { objMap } from '@hyperlane-xyz/utils';

import { owners } from './owners';

export const merkleTree: ChainMap<MerkleTreeHookConfig> = objMap(
  owners,
  (_, __) => {
    const config: MerkleTreeHookConfig = {
      type: HookType.MERKLE_TREE,
    };
    return config;
  },
);
