import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';

export type AccountConfig = {
  origin: ChainName;
  owner: Address;
  localRouter?: Address;
  routerOverride?: Address;
  ismOverride?: Address;
};
