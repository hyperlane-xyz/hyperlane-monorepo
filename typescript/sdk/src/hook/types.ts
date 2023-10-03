export enum HookType {
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
}

export type MerkleTreeHookConfig = {
  type: HookType.MERKLE_TREE;
};

export type IgpHookConfig = {
  type: HookType.INTERCHAIN_GAS_PAYMASTER;
};

export type HookConfig = MerkleTreeHookConfig | IgpHookConfig;
