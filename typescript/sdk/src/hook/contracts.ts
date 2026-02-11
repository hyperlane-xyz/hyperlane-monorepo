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
import {
  AmountRoutingHook__factory as TronAmountRoutingHook__factory,
  ArbL2ToL1Hook__factory as TronArbL2ToL1Hook__factory,
  CCIPHook__factory as TronCCIPHook__factory,
  DefaultHook__factory as TronDefaultHook__factory,
  DomainRoutingHook__factory as TronDomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory as TronFallbackDomainRoutingHook__factory,
  InterchainGasPaymaster__factory as TronInterchainGasPaymaster__factory,
  MerkleTreeHook__factory as TronMerkleTreeHook__factory,
  OPStackHook__factory as TronOPStackHook__factory,
  PausableHook__factory as TronPausableHook__factory,
  ProtocolFee__factory as TronProtocolFee__factory,
  StaticAggregationHook__factory as TronStaticAggregationHook__factory,
} from '@hyperlane-xyz/tron-sdk';
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

// Tron-compiled factories for TVM compatibility
export const tronHookFactories = {
  [HookType.MERKLE_TREE]: new TronMerkleTreeHook__factory(),
  [HookType.PROTOCOL_FEE]: new TronProtocolFee__factory(),
  [HookType.INTERCHAIN_GAS_PAYMASTER]:
    new TronInterchainGasPaymaster__factory(),
  [HookType.AGGREGATION]: new TronStaticAggregationHook__factory(),
  [HookType.OP_STACK]: new TronOPStackHook__factory(),
  [HookType.ROUTING]: new TronDomainRoutingHook__factory(),
  [HookType.FALLBACK_ROUTING]: new TronFallbackDomainRoutingHook__factory(),
  [HookType.PAUSABLE]: new TronPausableHook__factory(),
  [HookType.ARB_L2_TO_L1]: new TronArbL2ToL1Hook__factory(),
  [HookType.AMOUNT_ROUTING]: new TronAmountRoutingHook__factory(),
  [HookType.MAILBOX_DEFAULT]: new TronDefaultHook__factory(),
  [HookType.CCIP]: new TronCCIPHook__factory(),
};

export type HookFactories = typeof hookFactories;

export type DeployedHook = Awaited<
  ReturnType<ValueOf<HookFactories>['deploy']>
>;
