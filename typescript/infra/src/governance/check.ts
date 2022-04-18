import { GovernanceRouter } from '@abacus-network/apps';
import { AbacusRouterChecker, Ownable } from '@abacus-network/deploy';
import {
  AbacusGovernance,
  GovernanceDeployedNetworks,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { expect } from 'chai';
import { ethers } from 'ethers';
import { GovernanceConfig } from './types';

export class AbacusGovernanceChecker extends AbacusRouterChecker<
  GovernanceDeployedNetworks,
  AbacusGovernance,
  GovernanceConfig<GovernanceDeployedNetworks>
> {
  async checkDomain(domain: types.Domain, owner: types.Address): Promise<void> {
    await super.checkDomain(domain, owner);
    await this.checkProxiedContracts(domain);
    await this.checkRecoveryManager(domain);
  }

  async checkProxiedContracts(domain: types.Domain): Promise<void> {
    const addresses = this.app.mustGetContracts(domain).addresses;
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(domain, 'GovernanceRouter', addresses.router);
  }

  async checkDomainOwnership(domain: types.Domain): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const owners = [contracts.upgradeBeaconController.owner()];
    // If the config specifies that a xAppConnectionManager should have been deployed,
    // it should be owned by the router.
    if (!this.config.xAppConnectionManager) {
      owners.push(contracts.xAppConnectionManager.owner());
    }
    const expected = contracts.router.address;
    (await Promise.all(owners)).map((_) => expect(_).to.equal(expected));

    // Router should be owned by governor, or null address if not configured.
    const actual = await this.mustGetRouter(domain).governor();
    const addresses =
      this.config.addresses[this.app.mustResolveDomainName(domain)];
    if (!addresses) throw new Error('could not find addresses');
    if (addresses.governor) {
      expect(actual).to.equal(addresses.governor);
    } else {
      expect(actual).to.equal(ethers.constants.AddressZero);
    }
  }

  ownables(domain: types.Domain): Ownable[] {
    const ownables = super.ownables(domain);
    ownables.push(this.app.mustGetContracts(domain).upgradeBeaconController);
    return ownables;
  }

  async checkRecoveryManager(domain: types.Domain): Promise<void> {
    const actual = await this.mustGetRouter(domain).recoveryManager();
    const addresses =
      this.config.addresses[this.app.mustResolveDomainName(domain)];
    if (!addresses) throw new Error('could not find addresses');
    expect(actual).to.equal(addresses.recoveryManager);
  }

  mustGetRouter(domain: types.Domain): GovernanceRouter {
    return this.app.mustGetContracts(domain).router;
  }
}
