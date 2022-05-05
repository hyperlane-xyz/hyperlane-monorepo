import { types } from '@abacus-network/utils';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig
};
