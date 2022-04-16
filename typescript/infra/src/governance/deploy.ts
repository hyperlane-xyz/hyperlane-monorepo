import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { AbacusRouterDeployer } from '@abacus-network/deploy';
import { GovernanceContractAddresses } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { GovernanceConfig } from './types';

export class AbacusGovernanceDeployer extends AbacusRouterDeployer<
  GovernanceContractAddresses,
  GovernanceConfig
> {
  async deployContracts(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<GovernanceContractAddresses> {
    const signer = this.mustGetSigner(domain);
    const overrides = this.getOverrides(domain);

    const xAppConnectionManager =
      await this.deployConnectionManagerIfNotConfigured(domain, config);

    const upgradeBeaconController = await this.deployContract(
      domain,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const router = await this.deployProxiedContract(
      domain,
      'GovernanceRouter',
      new GovernanceRouter__factory(signer),
      upgradeBeaconController.address,
      [config.recoveryTimelock],
      [xAppConnectionManager.address],
    );

    // Only transfer ownership if a new XCM was deployed.
    if (xAppConnectionManager.deployTransaction) {
      await xAppConnectionManager.transferOwnership(router.address, overrides);
    }
    await upgradeBeaconController.transferOwnership(router.address, overrides);

    return {
      router: router.addresses,
      upgradeBeaconController: upgradeBeaconController.address,
      xAppConnectionManager: xAppConnectionManager.address,
    };
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
      this.mustGetAddresses(domain).router.proxy,
      this.mustGetSigner(domain),
    );
  }
}
