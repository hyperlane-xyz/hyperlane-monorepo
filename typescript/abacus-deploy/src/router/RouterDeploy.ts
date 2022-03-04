import { utils, types } from '@abacus-network/utils';
import { Deploy } from '../deploy';

interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
}

export abstract class RouterDeploy<T, V> extends Deploy<T, V> {
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

  abstract router(domain: types.Domain): Router;
}
