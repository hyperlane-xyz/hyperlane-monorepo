import { AbacusDeployment } from '@abacus-network/abacus-sol/test/lib/AbacusDeployment';
import { toBytes32 } from '@abacus-network/abacus-sol/test/lib/utils';
import {
  Signer,
  Domain,
  Address,
} from '@abacus-network/abacus-sol/test/lib/types';

import {
  GovernanceRouter__factory,
  GovernanceRouter,
} from '../../../typechain';

export interface GovernanceInstance {
  domain: Domain;
  router: GovernanceRouter;
}

const recoveryTimelock = 60 * 60 * 24 * 7;
const nullAddress = '0x' + '00'.repeat(20);

export class GovernanceDeployment {
  constructor(
    public readonly domains: Domain[],
    public readonly instances: Record<number, GovernanceInstance>,
  ) {}

  static async fromAbacusDeployment(
    abacus: AbacusDeployment,
    governor: Signer,
    recoveryManager: Signer,
  ) {
    // Deploy routers.
    const instances: Record<number, GovernanceInstance> = {};
    for (const domain of abacus.domains) {
      const instance = await GovernanceDeployment.deployInstance(
        domain,
        governor,
        recoveryManager,
        abacus.connectionManager(domain).address,
      );
      instances[domain] = instance;
    }

    // Make all routers aware of eachother.
    for (const local of abacus.domains) {
      for (const remote of abacus.domains) {
        await instances[local].router.enrollRemoteRouter(
          remote,
          toBytes32(instances[remote].router.address),
        );
      }
    }

    // Set the governor on one router, clear it on all other routers.
    for (let i = 0; i < abacus.domains.length; i++) {
      const addr = i === 0 ? governor.address : nullAddress;
      await instances[abacus.domains[i]].router.setGovernor(addr);
    }

    return new GovernanceDeployment(abacus.domains, instances);
  }

  static async deployInstance(
    domain: Domain,
    governor: Signer,
    recoveryManager: Signer,
    connectionManagerAddress: Address,
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

  router(domain: Domain): GovernanceRouter {
    return this.instances[domain].router;
  }
}
