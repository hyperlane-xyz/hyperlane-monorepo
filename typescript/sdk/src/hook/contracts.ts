import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';

export const merkleTreeHookFactories = {
  merkleTreeHook: new MerkleTreeHook__factory(),
};
export const hookFactories = merkleTreeHookFactories;
export type MerkleTreeHookFactory = typeof merkleTreeHookFactories;

export type HookFactories = MerkleTreeHookFactory;
