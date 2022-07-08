import type { types } from '@abacus-network/utils';

import type { CheckerViolation } from '../types';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig;
};

export enum CoreViolationType {
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
  InterchainGasPaymasterNotDeployed = 'InterchainGasPaymasterNotDeployed',
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
    validatorManagerAddress: string;
  };
}

export interface InterchainGasPaymasterNotDeployedViolation
  extends CheckerViolation {
  type: CoreViolationType.InterchainGasPaymasterNotDeployed;
}
