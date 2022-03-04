import { ethers } from 'ethers';
import {
  utils,
  types,
} from '@abacus-network/abacus-sol/test';

import {
  GovernanceRouter__factory,
  GovernanceRouter,
} from '../../../typechain';

export interface GovernanceInstance {
  domain: types.Domain;
  router: GovernanceRouter;
}

const recoveryTimelock = 60 * 60 * 24 * 7;

export class GovernanceDeployment {
  constructor(
    public readonly domains: types.Domain[],
    public readonly instances: Record<number, GovernanceInstance>,
  ) {}

  static async fromAbacusDeployment(
    abacus: any,
    governor: types.Signer,
    recoveryManager: types.Signer,
  ) {
    // Deploy routers.
    const instances: Record<number, GovernanceInstance> = {};
    for (const domain of abacus.domains) {
      const instance = await GovernanceDeployment.deployInstance(
        domain,
        governor,
        recoveryManager,
        abacus.xAppConnectionManager(domain).address,
      );
      instances[domain] = instance;
    }

    // Make all routers aware of eachother.
    for (const local of abacus.domains) {
      for (const remote of abacus.domains) {
        await instances[local].router.enrollRemoteRouter(
          remote,
          utils.toBytes32(instances[remote].router.address),
        );
      }
    }

    // Set the governor on one router, clear it on all other routers.
    for (let i = 0; i < abacus.domains.length; i++) {
      const addr = i === 0 ? governor.address : ethers.constants.AddressZero;
      await instances[abacus.domains[i]].router.setGovernor(addr);
    }

    return new GovernanceDeployment(abacus.domains, instances);
  }

  static async deployInstance(
    domain: types.Domain,
    governor: types.Signer,
    recoveryManager: types.Signer,
    connectionManagerAddress: types.Address,
  ): Promise<GovernanceInstance> {
    const routerFactory = new GovernanceRouter__factory(governor);
    const router = await routerFactory.deploy(recoveryTimelock);
    await router.initialize(connectionManagerAddress);
    await router.transferOwnership(recoveryManager.address);
    return {
      domain,
      router,
    };
  }

  router(domain: types.Domain): GovernanceRouter {
    return this.instances[domain].router;
  }
}
