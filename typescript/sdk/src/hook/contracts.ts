import {
  AmountRoutingHook__factory,
  ArbL2ToL1Hook__factory,
  CCIPHook__factory,
  DefaultHook__factory,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory,
  InterchainGasPaymaster__factory,
  MerkleTreeHook__factory,
  OPStackHook__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
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
  [HookType.AMOUNT_ROUTING]: new AmountRoutingHook__factory(),
  [HookType.MAILBOX_DEFAULT]: new DefaultHook__factory(),
  [HookType.CCIP]: new CCIPHook__factory(),
};

export type HookFactories = typeof hookFactories;

export type DeployedHook = Awaited<
  ReturnType<ValueOf<HookFactories>['deploy']>
>;
