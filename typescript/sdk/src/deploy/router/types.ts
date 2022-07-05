import type { types } from '@abacus-network/utils';

import type { ConnectionClientConfig } from '../../router';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;
