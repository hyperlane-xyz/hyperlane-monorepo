import {
  InterchainGasPaymaster__factory,
  MerkleTreeHook__factory,
  StaticAggregationHook__factory,
  StaticProtocolFee__factory,
} from '@hyperlane-xyz/core';

import { HookType } from './types';

export const hookFactories = {
  [HookType.MERKLE_TREE]: new MerkleTreeHook__factory(),
  [HookType.PROTOCOL_FEE]: new StaticProtocolFee__factory(),
  [HookType.INTERCHAIN_GAS_PAYMASTER]: new InterchainGasPaymaster__factory(), // unused
  [HookType.AGGREGATION]: new StaticAggregationHook__factory(), // unused
};

export type HookFactories = typeof hookFactories;
