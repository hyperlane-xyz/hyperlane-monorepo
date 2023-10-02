import {
  MerkleTreeHook__factory,
  StaticMerkleRootMultisigIsm__factory,
  StaticMessageIdMultisigIsm__factory,
} from '@hyperlane-xyz/core';

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};

export const messageIdMultisigIsmFactory = {
  ism: new StaticMessageIdMultisigIsm__factory(),
};

export type MerkleRootHookFactories = typeof merkleRootHookFactories;
export type MultisigIsmFactories =
  | typeof merkleRootIsmFactories
  | typeof messageIdMultisigIsmFactory;

export const merkleRootIsmFactories = {
  ism: new StaticMerkleRootMultisigIsm__factory(),
};

export type MerkleRootInterceptorFactories = MerkleRootHookFactories &
  MultisigIsmFactories;

export type HookFactories = MerkleRootHookFactories;
export type IsmFactories = MultisigIsmFactories;

export type InterceptorFactories = HookFactories & IsmFactories;
