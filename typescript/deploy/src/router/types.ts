import { ConnectionClientConfig } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;
