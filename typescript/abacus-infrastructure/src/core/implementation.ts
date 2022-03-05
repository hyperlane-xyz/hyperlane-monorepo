import { core } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { BeaconProxy, CoreConfig } from '@abacus-network/abacus-deploy';
import { ethers } from 'ethers';
import { CoreDeploy } from './CoreDeploy';

export class ImplementationDeployer {
  private deploy: CoreDeploy;
  private config: CoreConfig;

  constructor(deploy: CoreDeploy, config: CoreConfig) {
    this.deploy = deploy;
    this.config = config;
  }

  deployOutboxImplementations(): Promise<void> {
    return this._deployImplementations(this._deployOutboxImplementation);
  }

  deployInboxImplementations(): Promise<void> {
    return this._deployImplementations(this._deployInboxImplementation);
  }

  /**
   * Deploys a Outbox implementation on the chain of the given deploy and updates
   * the deploy instance with the new contract.
   *
   * @param deploy - The deploy instance
   */
  private async _deployOutboxImplementation(domain: types.Domain) {
    const signer = this.deploy.signer(domain);
    const factory = new core.Outbox__factory(signer);
    const implementation = await factory.deploy(
      domain,
      this.deploy.chains[domain].overrides,
    );
    this.deploy.instances[domain].contracts.outbox =
      ImplementationDeployer.overrideBeaconProxyImplementation<core.Outbox>(
        implementation,
        signer.provider as ethers.providers.JsonRpcProvider,
        factory,
        this.deploy.instances[domain].contracts.outbox,
      );
  }

  /**
   * Deploys a Inbox implementation on the chain of the given deploy and updates
   * the deploy instance with the new contracts.
   *
   * @param deploy - The deploy instance
   */
  private async _deployInboxImplementation(domain: types.Domain) {
    const signer = this.deploy.signer(domain);
    const factory = new core.Inbox__factory(signer);
    const implementation = await factory.deploy(
      domain,
      this.config.processGas,
      this.config.reserveGas,
      this.deploy.chains[domain].overrides,
    );
    for (const remote of this.deploy.remotes(domain)) {
      this.deploy.instances[domain].contracts.inboxes[remote] =
        ImplementationDeployer.overrideBeaconProxyImplementation<core.Inbox>(
          implementation,
          signer.provider as ethers.providers.JsonRpcProvider,
          factory,
          this.deploy.instances[domain].contracts.inboxes[remote],
        );
    }
  }

  static overrideBeaconProxyImplementation<T extends ethers.Contract>(
    implementation: T,
    provider: ethers.providers.JsonRpcProvider,
    factory: ethers.ContractFactory,
    beaconProxy: BeaconProxy<T>,
  ): BeaconProxy<T> {
    const beacon = core.UpgradeBeacon__factory.connect(
      beaconProxy.beacon.address,
      provider,
    );
    return new BeaconProxy(
      implementation as T,
      factory.attach(beaconProxy.proxy.address) as T,
      beacon,
    );
  }

  /**
   * Deploy a new contract implementation to each chain in the deploys
   * array.
   *
   * @dev The first chain in the array will be the governing chain
   *
   * @param deploys - An array of chain deploys
   * @param deployImplementation - A function that deploys a new implementation
   */
  private async _deployImplementations(
    deployImplementation: (d: types.Domain) => void,
  ) {
    await this.deploy.ready();
    // Do it sequentially
    for (const domain of this.deploy.domains) {
      await deployImplementation(domain);
    }
  }
}
