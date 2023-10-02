import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';

export const merkleTreeHookFactory = {
  merkleTreeHook: new MerkleTreeHook__factory(),
};
export const hookFactories = merkleTreeHookFactory;
export type MerkleTreeHookFactory = typeof merkleTreeHookFactory;

export type HookFactories = MerkleTreeHookFactory;
