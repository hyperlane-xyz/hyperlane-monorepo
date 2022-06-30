import type { ConnectionClientConfig } from '../../router';

export type OwnableConfig = {
  owner: Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;
