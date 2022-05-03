import { expect } from 'chai';
import { ethers } from 'ethers';

import { AbacusRouterChecker, Ownable } from '@abacus-network/deploy';
import { AbacusGovernance, ChainName } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { GovernanceConfig } from './types';

export class AbacusGovernanceChecker<
  Networks extends ChainName,
> extends AbacusRouterChecker<
  Networks,
  AbacusGovernance<Networks>,
  GovernanceConfig<Networks>
> {
  async checkDomainAddresses(
    network: Networks,
    owner: types.Address,
  ): Promise<void> {
    await super.checkDomain(network, owner);
    await this.checkProxiedContracts(network);
    await this.checkRecoveryManager(network);
  }

  async checkProxiedContracts(network: Networks): Promise<void> {
    const addresses = this.app.getAddresses(network);
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(
      network,
      'GovernanceRouter',
      addresses.router,
    );
  }

  async checkDomainOwnership(network: Networks): Promise<void> {
    const contracts = this.app.getContracts(network);
    await this.checkOwnership(contracts.router.address, this.ownables(network));

    // Router should be owned by governor, or null address if not configured.
    const actual = await contracts.router.governor();
    const addresses = this.config.addresses[network];
    if (addresses.governor) {
      expect(actual).to.equal(addresses.governor);
    } else {
      expect(actual).to.equal(ethers.constants.AddressZero);
    }
  }

  ownables(network: Networks): Ownable[] {
    const contracts = this.app.getContracts(network);
    return super.ownables(network).concat(contracts.upgradeBeaconController);
  }

  async checkRecoveryManager(network: Networks): Promise<void> {
    const actual = await this.mustGetRouter(network).recoveryManager();
    const addresses = this.config.addresses[network];
    expect(actual).to.equal(addresses.recoveryManager);
  }

  mustGetRouter(network: Networks) {
    return this.app.getContracts(network).router;
  }
}
