import {
  IAggregationIsm,
  IInterchainSecurityModule,
  IMultisigIsm,
  IRoutingIsm,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types';

export type DeployedIsm =
  | IInterchainSecurityModule
  | IMultisigIsm
  | IAggregationIsm
  | IRoutingIsm;

export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG,
  MERKLE_ROOT_MULTISIG,
  MESSAGE_ID_MULTISIG,
}

export type MultisigIsmConfig = {
  type:
    | ModuleType.LEGACY_MULTISIG
    | ModuleType.MERKLE_ROOT_MULTISIG
    | ModuleType.MESSAGE_ID_MULTISIG;
  validators: Array<Address>;
  threshold: number;
};

export type RoutingIsmConfig = {
  type: ModuleType.ROUTING;
  owner: Address;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: ModuleType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type IsmConfig =
  | Address
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig;
