import { types, utils } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
} from '@abacus-network/core';
import { AbacusAppDeployer } from '../deploy';
import { Router, RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  T,
  C extends RouterConfig,
> extends AbacusAppDeployer<T, C> {
  protected core?: AbacusCore;

  constructor(core?: AbacusCore) {
    super();
    this.core = core;
  }

  async deploy(config: C) {
    await super.deploy(config);

    // Make all routers aware of eachother.
    for (const local of this.domainNumbers) {
      const router = this.mustGetRouter(local);
      for (const remote of this.remoteDomainNumbers(local)) {
        const remoteRouter = this.mustGetRouter(remote);
        await router.enrollRemoteRouter(
          remote,
          utils.addressToBytes32(remoteRouter.address),
        );
      }
    }
  }

  async deployConnectionManagerIfNotConfigured(
    domain: number,
    config: C,
  ): Promise<AbacusConnectionManager> {
    const name = this.mustResolveDomainName(domain);
    const signer = this.mustGetSigner(domain);
    if (config.abacusConnectionManager) {
      const configured = config.abacusConnectionManager[name];
      if (!configured) throw new Error('abacusConnectionManager not found');
      return AbacusConnectionManager__factory.connect(configured, signer);
    }

    const abacusConnectionManager: AbacusConnectionManager =
      await this.deployContract(
        domain,
        'AbacusConnectionManager',
        new AbacusConnectionManager__factory(signer),
      );
    const overrides = this.getOverrides(domain);
    if (!this.core)
      throw new Error('must set core or configure abacusConnectionManager');
    const core = this.core.mustGetContracts(domain);
    await abacusConnectionManager.setOutbox(core.outbox.address, overrides);
    for (const remote of this.core.remoteDomainNumbers(domain)) {
      await abacusConnectionManager.enrollInbox(
        remote,
        this.core.mustGetInbox(remote, domain).address,
        overrides,
      );
    }
    return abacusConnectionManager;
  }

  get routerAddresses(): Record<types.Domain, types.Address> {
    const addresses: Record<types.Domain, types.Address> = {};
    for (const domain of this.domainNumbers) {
      addresses[domain] = this.mustGetRouter(domain).address;
    }
    return addresses;
  }

  abstract mustGetRouter(domain: types.Domain): Router;
}
