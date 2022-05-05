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
  GovernanceConfig & {
    owner: types.Address;
  }
> {
  constructor(
    multiProvider: MultiProvider<any>,
    app: AbacusGovernance<Networks>,
    configMap: ChainMap<Networks, GovernanceConfig>,
  ) {
    const joinedConfig = utils.objMap(configMap, (_, config) => ({
      ...config,
      owner: config.governor ?? ethers.constants.AddressZero,
    }));
    super(multiProvider, app, joinedConfig);
  }

  // Governance contracts are not all owned by the same address to enable local and global governance
  async checkOwnership(network: Networks): Promise<void> {
    const contracts = this.app.getContracts(network);

    // check router is owned by global governor
    const routerOwner = await contracts.router.owner();
    expect(routerOwner).to.equal(this.configMap[network].owner);

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

  async checkRecoveryManager(network: Networks): Promise<void> {
    const actual = await this.mustGetRouter(network).recoveryManager();
    const config = this.configMap[network];
    expect(actual).to.equal(config.recoveryManager);
  }

  mustGetRouter(network: Networks) {
    return this.app.getContracts(network).router;
  }
}
