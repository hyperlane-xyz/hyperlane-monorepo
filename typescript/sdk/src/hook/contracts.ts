import {
  MerkleTreeHook__factory,
  StaticMerkleRootMultisigIsm__factory,
} from '@hyperlane-xyz/core';

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};

export type MerkleRootHookFactories = typeof merkleRootHookFactories;
export type MerkleRootIsmFactories = typeof merkleRootIsmFactories;

export const merkleRootIsmFactories = {
  ism: new StaticMerkleRootMultisigIsm__factory(),
};

export type MerkleRootInterceptorFactories = MerkleRootHookFactories &
  MerkleRootIsmFactories;

export type HookFactories = MerkleRootHookFactories;
export type IsmFactories = MerkleRootIsmFactories;

export type InterceptorFactories = HookFactories & IsmFactories;
