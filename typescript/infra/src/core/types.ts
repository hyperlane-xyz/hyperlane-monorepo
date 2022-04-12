import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';

export type MultisigValidatorManagerConfig = {
  validatorSet: Array<types.Address>;
  quorumThreshold: number;
};

export type CoreConfig = {
  multisigValidatorManagers: Partial<
    Record<ChainName, MultisigValidatorManagerConfig>
  >;
};
