import { types } from '@abacus-network/utils';

export interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
  // Technically its a bytes32...
  routers(domain: types.Domain): Promise<types.Address>;
  xAppConnectionManager(): Promise<types.Address>;
  transferOwnership(owner: types.Address): Promise<any>
  owner(): Promise<types.Address>
}

export type RouterAddresses = {
  upgradeBeaconController: types.Address;
  xAppConnectionManager: types.Address;
};

export type RouterConfig = {
  core: Record<string, RouterAddresses>;
};
