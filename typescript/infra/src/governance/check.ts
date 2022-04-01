import { ethers } from 'ethers';
import { expect } from 'chai';
import { GovernanceRouter } from '@abacus-network/apps';
import { types } from '@abacus-network/utils';
import { AbacusGovernance } from '@abacus-network/sdk';
import { AbacusRouterChecker } from '@abacus-network/deploy';

import { GovernanceConfig } from './types';

export class AbacusGovernanceChecker extends AbacusRouterChecker<
  AbacusGovernance,
  GovernanceConfig
> {
  async checkDomain(domain: types.Domain): Promise<void> {
    await super.checkDomain(domain);
    await this.checkProxiedContracts(domain);
    await this.checkGovernor(domain);
    await this.checkOwnership(domain);
    await this.checkRecoveryManager(domain);
  }

  async checkProxiedContracts(domain: types.Domain): Promise<void> {
    const addresses = this.app.mustGetContracts(domain).addresses;
    // Outbox upgrade setup contracts are defined
    await this.checkProxiedContract(
      domain,
      'GovernanceRouter',
      addresses.router,
    );
  }

  async checkGovernor(domain: types.Domain): Promise<void> {
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

  // TODO: Move to router checker?
  async checkOwnership(domain: types.Domain): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const owners = [
      // TODO: Local tests failing because the fake connection manager
      // we set isn't ownable.
      // contracts.xAppConnectionManager.owner(),
      contracts.upgradeBeaconController.owner(),
    ];
    const actual = await Promise.all(owners);
    const expected = contracts.router.address;
    actual.map((_) => expect(_).to.equal(expected));
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
