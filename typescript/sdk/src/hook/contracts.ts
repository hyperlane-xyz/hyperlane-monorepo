import {
  MerkleTreeHook__factory,
  OverheadIgp__factory,
  StaticMerkleRootMultisigIsm__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';

import { proxiedFactories } from '../router/types';

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};
export type MerkleRootHookFactories = typeof merkleRootHookFactories;
export type MerkleRootIsmFactories = typeof merkleRootIsmFactories;

export const igpFactories = {
  // interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  interchainGasPaymaster: new OverheadIgp__factory(),
  storageGasOracle: new StorageGasOracle__factory(),
  ...proxiedFactories,
};

export const merkleRootIsmFactories = {
  ism: new StaticMerkleRootMultisigIsm__factory(),
};

export type MerkleRootInterceptorFactories =
  | MerkleRootHookFactories
  | MerkleRootIsmFactories;

export type PostDispatchHookFactories =
  | MerkleRootInterceptorFactories
  | typeof merkleRootHookFactories
  | typeof igpFactories;
