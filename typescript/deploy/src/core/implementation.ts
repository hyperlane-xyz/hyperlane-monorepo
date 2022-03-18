import { Inbox__factory, Outbox__factory } from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { CoreDeploy } from './CoreDeploy';
import { CoreInstance } from './CoreInstance';
import { CoreContracts } from './CoreContracts';

export class ImplementationDeployer {
  private deploy: CoreDeploy;

  constructor(deploy: CoreDeploy) {
    this.deploy = deploy;
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
    const factory = new Outbox__factory(signer);
    const implementation = await factory.deploy(
      domain,
      this.deploy.chains[domain].overrides,
    );
    const addresses = this.deploy.instances[domain].contracts.toObject();
    addresses.outbox.implementation = implementation.address;
    const contracts = CoreContracts.fromObject(addresses, signer);
    const instance = new CoreInstance(this.deploy.chains[domain], contracts);
    this.deploy.instances[domain] = instance;
  }

  /**
   * Deploys a Inbox implementation on the chain of the given deploy and updates
   * the deploy instance with the new contracts.
   *
   * @param deploy - The deploy instance
   */
  private async _deployInboxImplementation(domain: types.Domain) {
    const signer = this.deploy.signer(domain);
    const factory = new Inbox__factory(signer);
    const implementation = await factory.deploy(
      domain,
      this.deploy.chains[domain].overrides,
    );
    const addresses = this.deploy.instances[domain].contracts.toObject();
    for (const remote of this.deploy.remotes(domain)) {
      addresses.inboxes[remote].implementation = implementation.address;
    }
    const contracts = CoreContracts.fromObject(addresses, signer);
    const instance = new CoreInstance(this.deploy.chains[domain], contracts);
    this.deploy.instances[domain] = instance;
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
