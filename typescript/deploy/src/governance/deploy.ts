import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';
import { ProxiedAddress } from '@abacus-network/sdk';
import { AbacusRouterDeployer } from '../router';
import { GovernanceConfig } from './types';

export class AbacusGovernanceDeployer extends AbacusRouterDeployer<
  ProxiedAddress,
  GovernanceConfig
> {
  async deployContracts(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<ProxiedAddress> {
    const signer = this.mustGetSigner(domain);
    const name = this.mustResolveDomainName(domain);
    const core = config.core[name];
    if (!core) throw new Error('could not find core');

    const router = await this.deployBeaconProxy(
      domain,
      'GovernanceRouter',
      new GovernanceRouter__factory(signer),
      core.upgradeBeaconController,
      [config.recoveryTimelock],
      [core.xAppConnectionManager],
    );

    return router.toObject();
  }

  async deploy(config: GovernanceConfig) {
    await super.deploy(config);

    // Transfer ownership of routers to governor and recovery manager.
    for (const local of this.domainNumbers) {
      const router = this.mustGetRouter(local);
      const name = this.mustResolveDomainName(local);
      const addresses = config.addresses[name];
      if (!addresses) throw new Error('could not find addresses');
      await router.transferOwnership(addresses.recoveryManager);
      if (addresses.governor !== undefined) {
        await router.setGovernor(addresses.governor);
      } else {
        await router.setGovernor(ethers.constants.AddressZero);
      }
    }
  }

  mustGetRouter(domain: number): GovernanceRouter {
    return GovernanceRouter__factory.connect(
      this.mustGetAddresses(domain).proxy,
      this.mustGetSigner(domain),
    );
  }
}
