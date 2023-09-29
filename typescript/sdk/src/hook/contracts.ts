import {
  DomainRoutingHook__factory,
  DomainRoutingIsm__factory,
  MerkleTreeHook__factory,
  StaticMerkleRootMultisigIsm__factory,
} from '@hyperlane-xyz/core';

export const merkleRootHookFactories = {
  hook: new MerkleTreeHook__factory(),
};
export const merkleRootIsmFactories = {
  ism: new StaticMerkleRootMultisigIsm__factory(),
};

export type MerkleRootHookFactories = typeof merkleRootHookFactories;
export type MerkleRootIsmFactories = typeof merkleRootIsmFactories;
export type MerkleRootInterceptorFactories = Partial<
  MerkleRootHookFactories & MerkleRootIsmFactories
>;

// routing

export const routingHookFactories = {
  hook: new DomainRoutingHook__factory(),
};
export const routingIsmFactories = {
  ism: new DomainRoutingIsm__factory(),
};

export type RoutingHookFactories = typeof routingHookFactories;
export type RoutingIsmFactories = typeof routingIsmFactories;
export type RoutingInterceptorFactories = Partial<
  RoutingHookFactories & RoutingIsmFactories
>;

// common

export type HookFactories = MerkleRootHookFactories | RoutingHookFactories;
export type IsmFactories = MerkleRootIsmFactories | RoutingIsmFactories;

export type InterceptorFactories = HookFactories & IsmFactories;
