import {
  IAggregationIsm,
  IMultisigIsm,
  IRoutingIsm,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types';

export type DeployedIsm = IMultisigIsm | IAggregationIsm | IRoutingIsm;

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
  validators: Array<types.Address>;
  threshold: number;
};

export type RoutingIsmConfig = {
  type: ModuleType.ROUTING;
  owner: types.Address;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: ModuleType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type IsmConfig =
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig;
