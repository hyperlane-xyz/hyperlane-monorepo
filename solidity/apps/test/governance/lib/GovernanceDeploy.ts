import { ethers } from 'ethers';
import { types, utils } from '@abacus-network/utils';
import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';

import {
  GovernanceRouter__factory,
  GovernanceRouter,
} from '../../../typechain';

export type Governor = {
  domain: types.Domain;
  address: types.Address;
};

export type GovernanceConfig = {
  signer: ethers.Signer;
  timelock: number;
  governor: Governor;
  recoveryManager: types.Address;
};

export class GovernanceDeploy extends TestRouterDeploy<
  GovernanceRouter,
  GovernanceConfig
> {
  async deploy(abacus: TestAbacusDeploy) {
    await super.deploy(abacus);
    for (const domain of this.domains) {
      if (domain == this.config.governor.domain) {
        await this.router(domain).setGovernor(this.config.governor.address);
      } else {
        await this.router(domain).setGovernor(ethers.constants.AddressZero);
      }
    }
  }

  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<GovernanceRouter> {
    const routerFactory = new GovernanceRouter__factory(this.config.signer);
    const router = await routerFactory.deploy(this.config.timelock);
    await router.initialize(abacus.xAppConnectionManager(domain).address);
    await router.transferOwnership(this.config.recoveryManager);
    return router;
  }

  router(domain: types.Domain): GovernanceRouter {
    return this.instances[domain];
  }
}
