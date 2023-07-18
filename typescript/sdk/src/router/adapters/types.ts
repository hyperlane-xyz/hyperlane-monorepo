import { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';

export interface IRouterAdapter {
  interchainSecurityModule(chain: ChainName): Promise<types.Address>;
  owner: (chain: ChainName) => Promise<types.Address>;
}

export interface IGasRouterAdapter extends IRouterAdapter {
  quoteGasPayment: (
    origin: ChainName,
    destination: ChainName,
  ) => Promise<string>;
}
