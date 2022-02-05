import * as contracts from 'optics-ts-interface/dist/optics-core';
import { BeaconProxy } from '../proxyUtils';
import { Contracts } from '../contracts';
import { CoreContractAddresses, ProxiedAddress } from '../../src/config/addresses';
import * as ethers from 'ethers';

export class CoreContracts extends Contracts {
  upgradeBeaconController?: contracts.UpgradeBeaconController;
  xAppConnectionManager?: contracts.XAppConnectionManager;
  updaterManager?: contracts.UpdaterManager;
  governanceRouter?: BeaconProxy<contracts.GovernanceRouter>;
  home?: BeaconProxy<contracts.Home>;
  replicas: Record<number, BeaconProxy<contracts.Replica>>;

  constructor() {
    super();
    this.replicas = {};
  }

  toObject(): CoreContractAddresses {
    const replicas: Record<number, ProxiedAddress> = {};
    Object.entries(this.replicas).forEach(([k, v]) => {
      replicas[k] = v.toObject();
    });

    return {
      upgradeBeaconController: this.upgradeBeaconController!.address,
      xAppConnectionManager: this.xAppConnectionManager!.address,
      updaterManager: this.updaterManager!.address,
      governanceRouter: this.governanceRouter!.toObject(),
      home: this.home!.toObject(),
      replicas,
    };
  }

  static fromAddresses(
    addresses: CoreContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): CoreContracts {
    const core = new CoreContracts();
    core.upgradeBeaconController =
      contracts.UpgradeBeaconController__factory.connect(
        addresses.upgradeBeaconController,
        provider,
      );
    core.xAppConnectionManager =
      contracts.XAppConnectionManager__factory.connect(
        addresses.xAppConnectionManager,
        provider,
      );
    core.updaterManager = contracts.UpdaterManager__factory.connect(
      addresses.updaterManager,
      provider,
    );

    core.governanceRouter = BeaconProxy.fromAddresses(contracts.GovernanceRouter, provider, addresses.governanceRouter)
    core.home = BeaconProxy.fromAddresses(contracts.Home, provider, addresses.home)

    for (const domain of Object.keys(addresses.replicas!)) {
      core.replicas[domain] = BeaconProxy.fromAddresses(contracts.Replica, provider, addresses.replicas![domain])
    }
    return core;
  }
}
