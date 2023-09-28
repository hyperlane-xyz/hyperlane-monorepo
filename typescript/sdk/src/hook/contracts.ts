import {
  MerkleTreeHook__factory,
  OPStackHook__factory,
  OPStackIsm__factory,
  StaticMerkleRootMultisigIsm__factory,
} from '@hyperlane-xyz/core';

// merkleRoot

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};
export const merkleRootIsmFactories = {
  ism: new StaticMerkleRootMultisigIsm__factory(),
};

export type MerkleRootHookFactories = typeof merkleRootHookFactories;
export type MerkleRootIsmFactories = typeof merkleRootIsmFactories;

export type MerkleRootInterceptorFactories = MerkleRootHookFactories &
  MerkleRootIsmFactories;

// opstack

export const opStackHookFactories = {
  hook: new OPStackHook__factory(),
};
export const opStackIsmFactories = {
  ism: new OPStackIsm__factory(),
};

export type OPStackHookFactories = typeof opStackHookFactories;
export type OPStackIsmFactories = typeof opStackIsmFactories;
export type OPStackInterceptorFactories = Partial<
  OPStackHookFactories & OPStackIsmFactories
>;

// common

export type HookFactories = MerkleRootHookFactories | OPStackHookFactories;
export type IsmFactories = MerkleRootIsmFactories | OPStackIsmFactories;

export type InterceptorFactories = HookFactories & IsmFactories;
