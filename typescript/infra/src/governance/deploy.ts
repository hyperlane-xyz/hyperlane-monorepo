import { GovernanceRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { AbacusRouterDeployer } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainMap,
  GovernanceAddresses,
  MultiProvider,
  utils,
} from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { GovernanceConfig } from './types';

export class AbacusGovernanceDeployer<
  Networks extends ChainName,
> extends AbacusRouterDeployer<
  Networks,
  GovernanceConfig<Networks>,
  GovernanceAddresses
> {
  constructor(
    multiProvider: MultiProvider<Networks>,
    config: GovernanceConfig<Networks>,
    core?: AbacusCore<Networks>,
  ) {
    const networks = Object.keys(config.addresses) as Networks[];
    const crossConfigMap = Object.fromEntries(
      networks.map((network) => [network, config]),
    ) as ChainMap<Networks, GovernanceConfig<Networks>>;
    super(multiProvider, crossConfigMap, core);
  }

  async deployContracts(
    network: Networks,
    config: GovernanceConfig<Networks>,
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
    await utils.promiseObjAll<Record<Networks, void>>(
      utils.objMap(deploymentOutput, async (local, addresses) => {
        const router = this.mustGetRouter(local, addresses);
        const config = this.configMap[local].addresses[local]; // TODO: check if this is correct
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
