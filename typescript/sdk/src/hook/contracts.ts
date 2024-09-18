import {
  ArbL2ToL1Hook__factory,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory,
  InterchainGasPaymaster__factory,
  MerkleTreeHook__factory,
  OPStackHook__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import {
  ArbL2ToL1Hook__artifact,
  DomainRoutingHook__artifact,
  FallbackDomainRoutingHook__artifact,
  InterchainGasPaymaster__artifact,
  MerkleTreeHook__artifact,
  OPStackHook__artifact,
  PausableHook__artifact,
  ProtocolFee__artifact,
  StaticAggregationHook__artifact,
} from '@hyperlane-xyz/core/artifacts';
import { ValueOf } from '@hyperlane-xyz/utils';

import { HookType } from './types.js';

export const hookFactories = {
  [HookType.MERKLE_TREE]: new MerkleTreeHook__factory(),
  [HookType.PROTOCOL_FEE]: new ProtocolFee__factory(),
  [HookType.INTERCHAIN_GAS_PAYMASTER]: new InterchainGasPaymaster__factory(), // unused
  [HookType.AGGREGATION]: new StaticAggregationHook__factory(), // unused
  [HookType.OP_STACK]: new OPStackHook__factory(),
  [HookType.ROUTING]: new DomainRoutingHook__factory(),
  [HookType.FALLBACK_ROUTING]: new FallbackDomainRoutingHook__factory(),
  [HookType.PAUSABLE]: new PausableHook__factory(),
  [HookType.ARB_L2_TO_L1]: new ArbL2ToL1Hook__factory(),
};
export const hookFactoriesArtifacts = {
  [HookType.MERKLE_TREE]: MerkleTreeHook__artifact,
  [HookType.PROTOCOL_FEE]: ProtocolFee__artifact,
  [HookType.INTERCHAIN_GAS_PAYMASTER]: InterchainGasPaymaster__artifact, // unused
  [HookType.AGGREGATION]: StaticAggregationHook__artifact, // unused
  [HookType.OP_STACK]: OPStackHook__artifact,
  [HookType.ROUTING]: DomainRoutingHook__artifact,
  [HookType.FALLBACK_ROUTING]: FallbackDomainRoutingHook__artifact,
  [HookType.PAUSABLE]: PausableHook__artifact,
  [HookType.ARB_L2_TO_L1]: ArbL2ToL1Hook__artifact,
};

export type HookFactories = typeof hookFactories;

export type DeployedHook = Awaited<
  ReturnType<ValueOf<HookFactories>['deploy']>
>;
