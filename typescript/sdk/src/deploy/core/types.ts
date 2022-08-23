import { MultisigValidatorManager } from '@abacus-network/core';
import type { types } from '@abacus-network/utils';

import type { CheckerViolation } from '../types';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig;
  owner?: types.Address;
};

export enum CoreViolationType {
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
  NotDeployed = 'NotDeployed',
}

export enum ValidatorViolationType {
  EnrollValidator = 'EnrollValidator',
  UnenrollValidator = 'UnenrollValidator',
  Threshold = 'Threshold',
}

export interface ValidatorManagerViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorManager;
}

export interface ValidatorViolation extends CheckerViolation {
  type: CoreViolationType.Validator;
  data: {
    type: ValidatorViolationType;
    validatorManager: MultisigValidatorManager;
  };
}

export interface NotDeployedViolation extends CheckerViolation {
  type: CoreViolationType.NotDeployed;
  data: {
    contract: string;
  };
}
