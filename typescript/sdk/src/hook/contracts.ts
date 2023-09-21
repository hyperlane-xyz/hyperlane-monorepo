import {
  MerkleTreeHook__factory,
  OPStackHook__factory,
  OverheadIgp__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

import { proxiedFactories } from '../router/types';

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};
export type MerkleRootHookFactories = typeof merkleRootHookFactories;

export const igpFactories = {
  // interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  interchainGasPaymaster: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  ...proxiedFactories,
};

export const opStackHookFactories = {
  hook: new OPStackHook__factory(),
};

export type PostDispatchHookFactories =
  | typeof opStackHookFactories
  | typeof merkleRootHookFactories
  | typeof igpFactories;
