import { ethers } from 'ethers';

import { ControllerRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { AbacusRouterDeployer } from '@abacus-network/deploy';
import {
  ChainName,
  ControllerAddresses,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import { ControllerConfig } from './types';

export class ControllerDeployer<
  Chain extends ChainName,
> extends AbacusRouterDeployer<Chain, ControllerConfig, ControllerAddresses> {
  async deployContracts(
    chain: Chain,
    config: ControllerConfig,
  ): Promise<ControllerAddresses> {
    const dc = this.multiProvider.getChainConnection(chain);
    const signer = dc.signer!;

    const abacusConnectionManager =
      await this.deployConnectionManagerIfNotConfigured(chain);

    const upgradeBeaconController = await this.deployContract(
      chain,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const router = await this.deployProxiedContract(
      chain,
      'ControllerRouter',
      new ControllerRouter__factory(signer),
      [config.recoveryTimelock],
      upgradeBeaconController.address,
      [abacusConnectionManager.address],
    );

    // Only transfer ownership if a new ACM was deployed.
    if (abacusConnectionManager.deployTransaction) {
      await abacusConnectionManager.transferOwnership(
        router.address,
        dc.overrides,
      );
    }
    await upgradeBeaconController.transferOwnership(
      router.address,
      dc.overrides,
    );

    return {
      router: router.addresses,
      upgradeBeaconController: upgradeBeaconController.address,
      abacusConnectionManager: abacusConnectionManager.address,
    };
  }

  async deploy() {
    const deploymentOutput = await super.deploy();

    // Transfer ownership of routers to governor and recovery manager.
    await promiseObjAll(
      objMap(deploymentOutput, async (local, addresses) => {
        const router = this.mustGetRouter(local, addresses);
        const config = this.configMap[local];
        await router.transferOwnership(config.recoveryManager);
        await router.setController(
          config.controller ?? ethers.constants.AddressZero,
        );
      }),
    );

    return deploymentOutput;
  }

  mustGetRouter(chain: Chain, addresses: ControllerAddresses) {
    return ControllerRouter__factory.connect(
      addresses.router.proxy,
      this.multiProvider.getChainConnection(chain).signer!,
    );
  }
}
