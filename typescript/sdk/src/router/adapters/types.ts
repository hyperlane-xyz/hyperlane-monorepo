import { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';

export interface IRouterAdapter {
  interchainSecurityModule(chain: ChainName): Promise<types.Address>;
  owner: (chain: ChainName) => Promise<types.Address>;
  remoteDomains(originChain: ChainName): Promise<types.Domain[]>;
  remoteRouter: (
    originChain: ChainName,
    remoteDomain: types.Domain,
  ) => Promise<types.Address>;
  remoteRouters: (
    originChain: ChainName,
  ) => Promise<Array<{ domain: types.Domain; address: types.Address }>>;
}

export interface IGasRouterAdapter extends IRouterAdapter {
  quoteGasPayment: (
    origin: ChainName,
    destination: ChainName,
  ) => Promise<string>;
}
