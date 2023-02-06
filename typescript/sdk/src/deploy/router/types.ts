import type { types } from '@hyperlane-xyz/utils';

import type { ConnectionClientConfig } from '../../router';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;

type GasConfig = {
  gas: number;
};

export type GasRouterConfig = RouterConfig & GasConfig;
