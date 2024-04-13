import {
  IAggregationIsm,
  IMultisigIsm,
  IRoutingIsm,
  OPStackIsm,
  PausableIsm,
  TestIsm,
} from '@hyperlane-xyz/core';
import type { Address, Domain, ValueOf } from '@hyperlane-xyz/utils';

import { OwnableConfig } from '../deploy/types.js';
import { ChainMap } from '../types.js';

// this enum should match the IInterchainSecurityModule.sol enum
// meant for the relayer
export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG, // DEPRECATED
  MERKLE_ROOT_MULTISIG,
  MESSAGE_ID_MULTISIG,
  NULL,
  CCIP_READ,
}

// this enum can be adjusted as per deployments necessary
// meant for the deployer and checker
export enum IsmType {
  OP_STACK = 'opStackIsm', // NULL
  ROUTING = 'domainRoutingIsm', // ROUTING
  FALLBACK_ROUTING = 'defaultFallbackRoutingIsm', // ROUTING
  AGGREGATION = 'staticAggregationIsm', // AGGREGATION
  MERKLE_ROOT_MULTISIG = 'merkleRootMultisigIsm', // MERKLE_ROOT_MULTISIG
  MESSAGE_ID_MULTISIG = 'messageIdMultisigIsm', // MESSAGE_ID_MULTISIG
  TEST_ISM = 'testIsm', // NULL
  PAUSABLE = 'pausableIsm', // NULL
}

// mapping between the two enums
export function ismTypeToModuleType(ismType: IsmType): ModuleType {
  switch (ismType) {
    case IsmType.OP_STACK:
      return ModuleType.NULL;
    case IsmType.ROUTING:
      return ModuleType.ROUTING;
    case IsmType.FALLBACK_ROUTING:
      return ModuleType.ROUTING;
    case IsmType.AGGREGATION:
      return ModuleType.AGGREGATION;
    case IsmType.MERKLE_ROOT_MULTISIG:
      return ModuleType.MERKLE_ROOT_MULTISIG;
    case IsmType.MESSAGE_ID_MULTISIG:
      return ModuleType.MESSAGE_ID_MULTISIG;
    case IsmType.TEST_ISM:
      return ModuleType.NULL;
    case IsmType.PAUSABLE:
      return ModuleType.NULL;
  }
}

export type MultisigConfig = {
  validators: Array<Address>;
  threshold: number;
};

export type MultisigIsmConfig = MultisigConfig & {
  type: IsmType.MERKLE_ROOT_MULTISIG | IsmType.MESSAGE_ID_MULTISIG;
};

export type TestIsmConfig = {
  type: IsmType.TEST_ISM;
};

export type PausableIsmConfig = OwnableConfig & {
  type: IsmType.PAUSABLE;
  paused?: boolean;
};

export type RoutingIsmConfig = OwnableConfig & {
  type: IsmType.ROUTING | IsmType.FALLBACK_ROUTING;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: IsmType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type OpStackIsmConfig = {
  type: IsmType.OP_STACK;
  origin: Address;
  nativeBridge: Address;
};

export type IsmConfig =
  | Address
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig
  | OpStackIsmConfig
  | TestIsmConfig
  | PausableIsmConfig;

export type DeployedIsmType = {
  [IsmType.ROUTING]: IRoutingIsm;
  [IsmType.FALLBACK_ROUTING]: IRoutingIsm;
  [IsmType.AGGREGATION]: IAggregationIsm;
  [IsmType.MERKLE_ROOT_MULTISIG]: IMultisigIsm;
  [IsmType.MESSAGE_ID_MULTISIG]: IMultisigIsm;
  [IsmType.OP_STACK]: OPStackIsm;
  [IsmType.TEST_ISM]: TestIsm;
  [IsmType.PAUSABLE]: PausableIsm;
};

export type DeployedIsm = ValueOf<DeployedIsmType>;

// for finding the difference between the onchain deployment and the config provided
export type RoutingIsmDelta = {
  domainsToUnenroll: Domain[]; // new or updated isms for the domain
  domainsToEnroll: Domain[]; // isms to remove
  owner?: Address; // is the owner different
  mailbox?: Address; // is the mailbox different (only for fallback routing)
};
