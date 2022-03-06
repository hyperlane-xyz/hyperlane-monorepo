import { types, utils } from "@abacus-network/utils";
import { TestDeploy } from "./TestDeploy";
import { TestAbacusDeploy } from "./TestAbacusDeploy"

export interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
}

export abstract class TestRouterDeploy<T, V> extends TestDeploy<T, V>{

  async deploy(abacus: TestAbacusDeploy) {
    for (const domain of abacus.domains) {
      this.instances[domain] = await this.deployInstance(domain, abacus);
    }
    for (const local of this.domains) {
      for (const remote of this.remotes(local)) {
        await this.router(local).enrollRemoteRouter(remote, utils.addressToBytes32(this.router(remote).address))
      }
    }
  }

  abstract deployInstance(domain: types.Domain, abacus: TestAbacusDeploy): Promise<T>;
  abstract router(domain: types.Domain): Router;
}
