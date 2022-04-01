import { types, utils } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import {
  XAppConnectionManager,
  XAppConnectionManager__factory,
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
  ): Promise<XAppConnectionManager> {
    const name = this.mustResolveDomainName(domain);
    const signer = this.mustGetSigner(domain);
    if (config.xAppConnectionManager) {
      const configured = config.xAppConnectionManager[name];
      if (!configured) throw new Error('xAppConectionManager not found');
      return XAppConnectionManager__factory.connect(configured, signer);
    }

    const xAppConnectionManager: XAppConnectionManager =
      await this.deployContract(
        domain,
        'XAppConnectionManager',
        new XAppConnectionManager__factory(signer),
      );
    const overrides = this.getOverrides(domain);
    if (!this.core)
      throw new Error('must set core or configure xAppConnectionManager');
    const core = this.core.mustGetContracts(domain);
    await xAppConnectionManager.setOutbox(core.outbox.address, overrides);
    for (const remote of this.core.remoteDomainNumbers(domain)) {
      await xAppConnectionManager.enrollInbox(
        remote,
        this.core.mustGetInbox(remote, domain).address,
        overrides,
      );
    }
    return xAppConnectionManager;
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
