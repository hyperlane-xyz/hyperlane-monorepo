import {
  MerkleTreeHook__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';

import { IgpFactories } from '../gas/contracts';

export const merkleTreeHookFactory = {
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
export type AggregationHookFactory = typeof aggregationHookFactory;
export const hookFactories = merkleTreeHookFactory;
export type MerkleTreeHookFactory = typeof merkleTreeHookFactory;

export type HookFactories = Partial<
  MerkleTreeHookFactory & AggregationHookFactory & IgpFactories
>;
