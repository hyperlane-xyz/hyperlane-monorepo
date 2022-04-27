import { ChainName, ChainMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig<Networks extends ChainName> = {
  validatorManagers: ChainMap<Networks, ValidatorManagerConfig>;
};
