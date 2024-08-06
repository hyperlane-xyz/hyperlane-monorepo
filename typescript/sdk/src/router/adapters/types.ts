import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseAppAdapter } from '../../app/MultiProtocolApp.js';
import { ChainName } from '../../types.js';

export interface IRouterAdapter extends BaseAppAdapter {
  interchainSecurityModule(): Promise<Address>;
  owner: () => Promise<Address>;
  remoteDomains(): Promise<Domain[]>;
  remoteRouter: (remoteDomain: Domain) => Promise<Address>;
  remoteRouters: () => Promise<Array<{ domain: Domain; address: Address }>>;
}

export interface IGasRouterAdapter extends IRouterAdapter {
  quoteGasPayment: (destination: ChainName) => Promise<string>;
}
