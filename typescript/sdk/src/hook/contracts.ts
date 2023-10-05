import {
  MerkleTreeHook__factory,
  TestInterchainGasPaymaster__factory,
} from '@hyperlane-xyz/core';

import { HookType } from './types';

export const hookFactories = {
  [HookType.MERKLE_TREE]: new MerkleTreeHook__factory(),
  [HookType.INTERCHAIN_GAS_PAYMASTER]:
    new TestInterchainGasPaymaster__factory(),
};

export type HookFactories = typeof hookFactories;
