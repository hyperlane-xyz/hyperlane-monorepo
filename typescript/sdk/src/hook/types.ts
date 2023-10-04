import { IgpConfig } from '../gas/types';

export enum HookType {
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
  AGGREGATION = 'aggregation',
}

export type MerkleTreeHookConfig = {
  type: HookType.MERKLE_TREE;
};

export type AggregationHookConfig = {
  type: HookType.AGGREGATION;
  modules: HookConfig[];
};

export type IgpHookConfig = IgpConfig & {
  type: HookType.INTERCHAIN_GAS_PAYMASTER;
};

export type HookConfig =
  | MerkleTreeHookConfig
  | AggregationHookConfig
  | IgpHookConfig;
