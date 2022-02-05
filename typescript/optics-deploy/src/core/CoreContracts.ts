import * as contracts from 'optics-ts-interface/dist/optics-core';
import { BeaconProxy } from '../proxyUtils';
import { Contracts } from '../contracts';
import { DomainedProxiedAddress, ProxiedAddress, CoreContractAddresses } from '../../src/config/addresses';
import * as ethers from 'ethers';

export class CoreContracts extends Contracts {
  upgradeBeaconController?: contracts.UpgradeBeaconController;
  xAppConnectionManager?: contracts.XAppConnectionManager;
  updaterManager?: contracts.UpdaterManager;
  governanceRouter?: BeaconProxy<contracts.GovernanceRouter>;
  home?: BeaconProxy<contracts.Home>;
  replicas: Record<DomainedChain, BeaconProxy<contracts.Replica>>;

  constructor() {
    super();
    this.replicas = {};
  }

  toObject(): CoreContractAddresses {
    const replicas: Record<ChainName, DomainedProxiedAddress> = {};
    Object.entries(this.replicas).forEach(([k, v]) => {
      replicas[k.name] = {
        ...k,
        ...v.toObject(),
      }
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

    core.governanceRouter = BeaconProxy.from(contracts.GovernanceRouter__factory, provider, addresses.governanceRouter)
    core.home = BeaconProxy.from(contracts.Home__factory, provider, addresses.home)

    for (let domain of Object.keys(addresses.replicas!)) {
      core.replicas[parseInt(domain)] = BeaconProxy.from(contracts.Replica__factory, provider, addresses.replicas![domain])
    }
    return core;
  }
}
