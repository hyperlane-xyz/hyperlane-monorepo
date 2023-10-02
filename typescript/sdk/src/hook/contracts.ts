import {
  MerkleTreeHook__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';

export const merkleTreeHookFactories = {
  merkleTreeHook: new MerkleTreeHook__factory(),
};
export const aggregationHookFactoryFactories = {
  aggregationHookFactory: new StaticAggregationHookFactory__factory(),
};
export type AggregationHookFactoryFactories =
  typeof aggregationHookFactoryFactories;
export const aggregationHookFactory = {
  aggregationHook: new StaticAggregationHook__factory(),
};
export const hookFactories = merkleTreeHookFactories;
export type MerkleTreeHookFactory = typeof merkleTreeHookFactories;
export type AggregationHookFactory = typeof aggregationHookFactory;

export type HookFactories = Partial<
  MerkleTreeHookFactory & AggregationHookFactory
>;
