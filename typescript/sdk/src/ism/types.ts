import {
  DomainRoutingIsm,
  LegacyMultisigIsm,
  StaticAggregationIsm,
  StaticMultisigIsm,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types';
import { ChainMap, ChainName } from '../types';

export type DeployedIsm =
  | StaticMultisigIsm
  | StaticAggregationIsm
  | DomainRoutingIsm;

export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG,
  MULTISIG,
}

export type TypedIsmConfig = {
  type: ModuleType;
};

export type MultisigIsmConfig = TypedIsmConfig & {
  type: ModuleType.MULTISIG;
  validators: Array<types.Address>;
  threshold: number;
};

export type RoutingIsmConfig = TypedIsmConfig & {
  type: ModuleType.ROUTING;
  owner: types.Address;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = TypedIsmConfig & {
  type: ModuleType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type IsmConfig =
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig;

export enum MultisigIsmViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export interface MultisigIsmViolation extends CheckerViolation {
  type: 'MultisigIsm';
  contract: LegacyMultisigIsm;
  subType: MultisigIsmViolationType;
  remote: ChainName;
}

export interface EnrolledValidatorsViolation extends MultisigIsmViolation {
  subType: MultisigIsmViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends MultisigIsmViolation {
  subType: MultisigIsmViolationType.Threshold;
  actual: number;
  expected: number;
}
