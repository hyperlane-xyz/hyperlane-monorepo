import { ethers } from 'ethers';
import { types, utils } from '@abacus-network/utils';
import { RouterDeploy } from '@abacus-network/abacus-deploy/src/router/RouterDeploy';

import {
  GovernanceRouter__factory,
  GovernanceRouter,
} from '../../../typechain';

export type GovernanceConfig = {
  signer: ethers.Signer;
  timelock: number;
  connectionManager: Record<types.Domain, types.Address>;
  governors: Record<types.Domain, types.Address>;
  recoveryManagers: Record<types.Domain, types.Address>;
};

export class GovernanceDeploy extends RouterDeploy<
  GovernanceRouter,
  GovernanceConfig
> {
  async deployInstance(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<GovernanceRouter> {
    const routerFactory = new GovernanceRouter__factory(config.signer);
    const router = await routerFactory.deploy(config.timelock);
    await router.initialize(config.connectionManager[domain]);
    await router.transferOwnership(config.recoveryManagers[domain]);
    return router;
  }

  async postDeploy(config: GovernanceConfig) {
    await super.postDeploy(config);
    for (const domain of this.domains) {
      await this.router(domain).setGovernor(config.governors[domain]);
    }
  }

  router(domain: types.Domain): GovernanceRouter {
    return this.instances[domain];
  }
}
