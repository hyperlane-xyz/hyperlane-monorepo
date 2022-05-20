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
  Chain extends ChainName,
> extends AbacusRouterChecker<
  Chain,
  ControllerApp<Chain>,
  ControllerConfig & {
    owner: types.Address;
  }
> {
  constructor(
    multiProvider: MultiProvider<any>,
    app: ControllerApp<Chain>,
    configMap: ChainMap<Chain, ControllerConfig>,
  ) {
    const joinedConfig = objMap(configMap, (_, config) => ({
      ...config,
      owner: config.controller ?? ethers.constants.AddressZero,
    }));
    super(multiProvider, app, joinedConfig);
  }

  // ControllerRouter's owner is 0x0 on all chains except the controlling chain as setup in the constructor
  async checkOwnership(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);

    // check router's owner with the config
    const routerOwner = await contracts.router.owner();
    expect(routerOwner).to.equal(this.configMap[chain].owner);

    // check ubc is owned by local router
    const ubcOwner = await contracts.upgradeBeaconController.owner();
    expect(ubcOwner).to.equal(contracts.router.address);
  }

  async checkChain(chain: Chain): Promise<void> {
    await super.checkChain(chain);
    await this.checkProxiedContracts(chain);
    await this.checkRecoveryManager(chain);
  }

  async checkProxiedContracts(chain: Chain): Promise<void> {
    const addresses = this.app.getAddresses(chain);
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(chain, 'ControllerRouter', addresses.router);
  }

  async checkRecoveryManager(chain: Chain): Promise<void> {
    const actual = await this.mustGetRouter(chain).recoveryManager();
    const config = this.configMap[chain];
    expect(actual).to.equal(config.recoveryManager);
  }

  mustGetRouter(chain: Chain) {
    return this.app.getContracts(chain).router;
  }
}
