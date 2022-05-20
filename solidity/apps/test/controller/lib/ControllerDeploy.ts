import { ethers } from 'ethers';

import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';
import { types } from '@abacus-network/utils';

import { ControllerRouter, ControllerRouter__factory } from '../../../types';

export type ControllingEntity = {
  domain: types.Domain;
  address: types.Address;
};

export type ControllerConfig = {
  signer: ethers.Signer;
  timelock: number;
  controller: ControllingEntity;
  recoveryManager: types.Address;
};

export class ControllerDeploy extends TestRouterDeploy<
  ControllerRouter,
  ControllerConfig
> {
  async deploy(abacus: TestAbacusDeploy) {
    await super.deploy(abacus);
    for (const domain of this.domains) {
      if (domain == this.config.controller.domain) {
        await this.router(domain).setController(this.config.controller.address);
      } else {
        await this.router(domain).setController(ethers.constants.AddressZero);
      }
    }
  }

  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<ControllerRouter> {
    const routerFactory = new ControllerRouter__factory(this.config.signer);
    const router = await routerFactory.deploy(this.config.timelock);
    await router.initialize(abacus.abacusConnectionManager(domain).address);
    await router.transferOwnership(this.config.recoveryManager);
    return router;
  }

  router(domain: types.Domain): ControllerRouter {
    return this.instances[domain];
  }
}
