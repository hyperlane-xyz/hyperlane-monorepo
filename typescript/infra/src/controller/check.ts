import { expect } from 'chai';
import { ethers } from 'ethers';

import { AbacusRouterChecker } from '@abacus-network/deploy';
import {
  ChainMap,
  ChainName,
  ControllerApp,
  MultiProvider,
  objMap,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { ControllerConfig } from './types';

export class ControllerChecker<
  Networks extends ChainName,
> extends AbacusRouterChecker<
  Networks,
  ControllerApp<Networks>,
  ControllerConfig & {
    owner: types.Address;
  }
> {
  constructor(
    multiProvider: MultiProvider<any>,
    app: ControllerApp<Networks>,
    configMap: ChainMap<Networks, ControllerConfig>,
  ) {
    const joinedConfig = objMap(configMap, (_, config) => ({
      ...config,
      owner: config.controller ?? ethers.constants.AddressZero,
    }));
    super(multiProvider, app, joinedConfig);
  }

  // ControllerRouter's owner is 0x0 on all chains except the controlling chain as setup in the constructor
  async checkOwnership(network: Networks): Promise<void> {
    const contracts = this.app.getContracts(network);

    // check router's owner with the config
    const routerOwner = await contracts.router.owner();
    expect(routerOwner).to.equal(this.configMap[network].owner);

    // check ubc is owned by local router
    const ubcOwner = await contracts.upgradeBeaconController.owner();
    expect(ubcOwner).to.equal(contracts.router.address);
  }

  async checkChain(network: Networks): Promise<void> {
    await super.checkChain(network);
    await this.checkProxiedContracts(network);
    await this.checkRecoveryManager(network);
  }

  async checkProxiedContracts(network: Networks): Promise<void> {
    const addresses = this.app.getAddresses(network);
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(
      network,
      'ControllerRouter',
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
