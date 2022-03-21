import { types, utils } from '@abacus-network/utils';
import { AbacusAppDeployer } from '../deploy';
import { Router } from './types';

export abstract class AbacusRouterDeployer<T, C> extends AbacusAppDeployer<T, C> {

  async deploy(config: C) {
    await super.deploy(config);

    // Make all routers aware of eachother.
    for (const local of this.domainNumbers) {
      const router = this.mustGetRouter(local);
      for (const remote of this.remoteDomainNumbers(local)) {
        const remoteRouter = this.mustGetRouter(remote)
        await router.enrollRemoteRouter(
          remote,
          utils.addressToBytes32(remoteRouter.address),
        );
      }
    }
  }

  /*
  routerAddresses(): Record<types.Domain, types.Address> {
    const addresses: Record<types.Domain, types.Address> = {};
    for (const domain of this.domains) {
      addresses[domain] = this.router(domain).address;
    }
    return addresses;
  }
  */

  abstract mustGetRouter(domain: types.Domain): Router;
}
