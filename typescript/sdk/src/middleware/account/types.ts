import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';

export type AccountConfig = {
  origin: ChainName;
  owner: Address;
  localRouter?: Address;
};
