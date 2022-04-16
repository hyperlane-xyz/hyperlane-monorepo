import { ChainName, ChainSubsetMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig<Networks extends ChainName> = {
  validatorManagers: ChainSubsetMap<Networks, ValidatorManagerConfig>;
};
