import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../contexts';
import { routingIsm } from '../../routingIsm';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = routingIsm('testnet3', local, Contexts.Hyperlane);
  return {
    owner,
    defaultIsm,
  };
});
