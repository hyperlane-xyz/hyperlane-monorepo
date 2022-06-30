import { types } from '@abacus-network/utils';

export type ConnectionClientConfig = {
  abacusConnectionManager: types.Address;
  interchainGasPaymaster?: types.Address;
};

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;
