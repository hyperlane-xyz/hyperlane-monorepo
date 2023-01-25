import type { types } from '@hyperlane-xyz/utils';

import type { ConnectionClientConfig } from '../../router';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;

type OverheadConfig = {
  handleGasOverhead: number;
};

export type GasRouterConfig = RouterConfig & OverheadConfig;
