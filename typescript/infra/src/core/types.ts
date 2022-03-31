import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';

export type CoreConfig = {
  validators: Partial<Record<ChainName, types.Address>>;
};
