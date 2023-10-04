import { IgpConfig } from '../gas/types';

export enum HookType {
  MERKLE_TREE_HOOK = 'merkleTreeHook',
  AGGREGATION = 'aggregation',
  IGP = 'igp',
}

export type MerkleTreeHookConfig = {
  type: HookType.MERKLE_TREE_HOOK;
};

export type AggregationHookConfig = {
  type: HookType.AGGREGATION;
  modules: Array<HookConfig>;
};

export type IgpHookConfig = IgpConfig & {
  type: HookType.IGP;
};

export type HookConfig =
  | MerkleTreeHookConfig
  | AggregationHookConfig
  | IgpHookConfig;
