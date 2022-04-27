import { ChainName, ChainSubsetMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
  // Technically a bytes32...
  routers(domain: types.Domain): Promise<types.Address>;
  abacusConnectionManager(): Promise<types.Address>;
  transferOwnership(owner: types.Address): Promise<any>;
  owner(): Promise<types.Address>;
}

export type RouterConfig<Networks extends ChainName> = { abacusConnectionManager?: ChainSubsetMap<Networks, types.Address>; };
