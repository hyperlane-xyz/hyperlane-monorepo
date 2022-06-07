import { RouterContracts, RouterFactories } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type RouterConfig<
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
> = {
  owner: types.Address;
  deployParams: Parameters<Factories['router']['deploy']>;
  initParams: Parameters<Contracts['router']['initialize']>;
};
