export enum HookType {
  MERKLE_TREE_HOOK = 'merkleTreeHook',
}

export type MerkleTreeHookConfig = {
  type: HookType.MERKLE_TREE_HOOK;
};

export type HookConfig = MerkleTreeHookConfig;
