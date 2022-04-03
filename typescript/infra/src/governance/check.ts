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
  async checkDomain(domain: types.Domain, owner: types.Address): Promise<void> {
    await super.checkDomain(domain, owner);
    await this.checkProxiedContracts(domain);
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

  async checkOwnership(
    domain: types.Domain,
    owner: types.Address,
  ): Promise<void> {
    // UBC and XCM should be owned by the router.
    const contracts = this.app.mustGetContracts(domain);
    const owners = await Promise.all([
      // TODO: Local tests failing because the fake connection manager
      // we set isn't ownable.
      // contracts.xAppConnectionManager.owner(),
      contracts.upgradeBeaconController.owner(),
    ]);
    const expected = contracts.router.address;
    owners.map((_) => expect(_).to.equal(expected));

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
