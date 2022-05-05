import { ethers } from 'ethers';

import { GovernanceRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { AbacusRouterDeployer } from '@abacus-network/deploy';
import { ChainName, GovernanceAddresses, utils } from '@abacus-network/sdk';

import { GovernanceConfig } from './types';

export class AbacusGovernanceDeployer<
  Networks extends ChainName,
> extends AbacusRouterDeployer<
  Networks,
  GovernanceConfig,
  GovernanceAddresses
> {
  async deployContracts(
    network: Networks,
    config: GovernanceConfig,
  ): Promise<GovernanceAddresses> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;

    const abacusConnectionManager =
      await this.deployConnectionManagerIfNotConfigured(network);

    const upgradeBeaconController = await this.deployContract(
      network,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const router = await this.deployProxiedContract(
      network,
      'GovernanceRouter',
      new GovernanceRouter__factory(signer),
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
    await utils.promiseObjAll(
      utils.objMap(deploymentOutput, async (local, addresses) => {
        const router = this.mustGetRouter(local, addresses);
        const config = this.configMap[local];
        await router.transferOwnership(config.recoveryManager);
        await router.setGovernor(
          config.governor ?? ethers.constants.AddressZero,
        );
      }),
    );

    return deploymentOutput;
  }

  mustGetRouter(network: Networks, addresses: GovernanceAddresses) {
    return GovernanceRouter__factory.connect(
      addresses.router.proxy,
      this.multiProvider.getDomainConnection(network).signer!,
    );
  }
}
