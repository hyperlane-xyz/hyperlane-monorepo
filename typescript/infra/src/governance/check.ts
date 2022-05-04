import { expect } from 'chai';
import { ethers } from 'ethers';

import { AbacusRouterChecker } from '@abacus-network/deploy';
import {
  AbacusGovernance,
  ChainMap,
  ChainName,
  MultiProvider,
  utils,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { GovernanceConfig } from './types';

export class AbacusGovernanceChecker<
  Networks extends ChainName,
> extends AbacusRouterChecker<
  Networks,
  AbacusGovernance<Networks>,
  GovernanceConfig<Networks> & {
    owners: ChainMap<Networks, types.Address>;
  }
> {
  constructor(
    multiProvider: MultiProvider<Networks>,
    app: AbacusGovernance<Networks>,
    config: GovernanceConfig<Networks>,
  ) {
    const owners = utils.objMap(
      config.addresses,
      (_, a) => a.governor ?? ethers.constants.AddressZero,
    );
    super(multiProvider, app, { ...config, owners });
  }

  // Governance contracts are not all owned by the same address to enable local and global governance
  async checkOwnership(network: Networks): Promise<void> {
    const contracts = this.app.getContracts(network);

    // check router is owned by global governor
    const routerOwner = await contracts.router.owner();
    expect(routerOwner).to.equal(this.config.owners[network]);

    // check ubc is owned by local router
    const ubcOwner = await contracts.upgradeBeaconController.owner();
    expect(ubcOwner).to.equal(contracts.router.address);
  }

  async checkDomain(network: Networks): Promise<void> {
    await super.checkDomain(network);
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

  // ownables(network: Networks): Ownable[] {
  //   const contracts = this.app.getContracts(network);
  //   return super.ownables(network).concat(contracts.upgradeBeaconController);
  // }

  async checkRecoveryManager(network: Networks): Promise<void> {
    const actual = await this.mustGetRouter(network).recoveryManager();
    const addresses = this.config.addresses[network];
    expect(actual).to.equal(addresses.recoveryManager);
  }

  mustGetRouter(network: Networks) {
    return this.app.getContracts(network).router;
  }
}
