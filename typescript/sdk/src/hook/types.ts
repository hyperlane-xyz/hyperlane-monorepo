import type { MultisigIsmConfig } from '../ism/types';

export enum HookType {
  MERKLE_ROOT_HOOK = 'merkleRootHook',
}

export type MerkleRootHookConfig = {
  type: HookType.MERKLE_ROOT_HOOK;
};

export type MerkleRootInterceptorConfig = {
  hook: MerkleRootHookConfig;
  ism: MultisigIsmConfig;
};

export type HookConfig = MerkleRootHookConfig;

export type InterceptorConfig = MerkleRootInterceptorConfig;
