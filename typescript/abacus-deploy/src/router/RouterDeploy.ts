import { types, utils } from '@abacus-network/utils';
import { CommonDeploy } from '../common';
import { RouterInstance } from './RouterInstance';
import { Router } from './types';

export abstract class RouterDeploy<
  T extends RouterInstance<any>,
  V,
> extends CommonDeploy<T, V> {
  async postDeploy(_: V) {
    // Make all routers aware of eachother.
    for (const local of this.domains) {
      for (const remote of this.domains) {
        if (local === remote) continue;
        await this.router(local).enrollRemoteRouter(
          remote,
          utils.addressToBytes32(this.router(remote).address),
        );
      }
    }
  }

  routerAddresses(): Record<types.Domain, types.Address> {
    const addresses: Record<types.Domain, types.Address> = {};
    for (const domain of this.domains) {
      addresses[domain] = this.router(domain).address;
    }
    return addresses;
  }

  abstract router(domain: types.Domain): Router;
}
