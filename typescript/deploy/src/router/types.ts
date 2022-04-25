import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';

export interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
  // Technically a bytes32...
  routers(domain: types.Domain): Promise<types.Address>;
  abacusConnectionManager(): Promise<types.Address>;
  transferOwnership(owner: types.Address): Promise<any>;
  owner(): Promise<types.Address>;
}

export type RouterConfig = {
  abacusConnectionManager?: Partial<Record<ChainName, types.Address>>;
};
