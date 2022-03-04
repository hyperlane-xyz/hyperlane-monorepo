import { ethers } from 'ethers';
import { utils } from '@abacus-network/abacus-sol/test';
import { types } from '@abacus-network/abacus-deploy';
import { RouterDeploy } from '@abacus-network/abacus-deploy/src/router/RouterDeploy';
import { types as testTypes } from '@abacus-network/abacus-sol/test';

import {
  GovernanceRouter__factory,
  GovernanceRouter,
} from '../../../typechain';

export type GovernanceConfig = {
  signer: testTypes.Signer;
  timelock: number;
  connectionManager: Record<number, types.Address>;
  governors: Record<number, types.Address>;
  recoveryManagers: Record<number, types.Address>;
};

// TODO(asa): Try to implement this using what I can import from abacus-network/hardhat
export class GovernanceDeploy extends RouterDeploy<
  GovernanceRouter,
  GovernanceConfig
> {
  async deployInstance(
    chain: types.ChainConfig,
    config: GovernanceConfig,
  ): Promise<GovernanceRouter> {
    const routerFactory = new GovernanceRouter__factory(config.signer);
    const router = await routerFactory.deploy(config.timelock);
    await router.initialize(config.connectionManager[chain.domain]);
    await router.transferOwnership(config.recoveryManagers[chain.domain]);
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
