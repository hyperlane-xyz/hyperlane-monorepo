import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManagers: Partial<Record<ChainName, ValidatorManagerConfig>>;
};
