import {
  IAggregationIsm,
  IInterchainSecurityModule,
  IMultisigIsm,
  IRoutingIsm,
  OPStackIsm,
  StaticMerkleRootMultisigIsm,
  StaticMessageIdMultisigIsm,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types';

export type DeployedIsm =
  | IInterchainSecurityModule
  | IMultisigIsm
  | IAggregationIsm
  | IRoutingIsm
  | StaticMessageIdMultisigIsm
  | StaticMerkleRootMultisigIsm
  | OPStackIsm;

// this enum should match the
export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG, // DEPRECATED
  MERKLE_ROOT_MULTISIG,
  MESSAGE_ID_MULTISIG,
  NULL,
}

export enum IsmType {
  OP_STACK,
  ROUTING,
  AGGREGATION,
  MERKLE_ROOT_MULTISIG,
  MESSAGE_ID_MULTISIG,
  TEST_ISM,
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

export type RoutingIsmConfig = {
  type: IsmType.ROUTING;
  owner: Address;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: IsmType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type OpStackIsmConfig = {
  type: IsmType.OP_STACK;
  nativeBridge: Address;
};

export type IsmConfig =
  | Address
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig
  | OpStackIsmConfig
  | TestIsmConfig;
