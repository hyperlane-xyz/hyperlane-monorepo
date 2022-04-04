import { expect } from 'chai';
import { types } from '@abacus-network/utils';
import { AbacusBridge } from '@abacus-network/sdk';
import { BridgeRouter } from '@abacus-network/apps';

import { BridgeConfig } from './types';
import { AbacusRouterChecker } from '../router';

export class AbacusBridgeChecker extends AbacusRouterChecker<
  AbacusBridge,
  BridgeConfig
> {
  async checkDomain(domain: types.Domain): Promise<void> {
    await super.checkDomain(domain);
    await this.checkProxiedContracts(domain);
    this.checkEthHelper(domain);
  }

  async checkProxiedContracts(domain: types.Domain): Promise<void> {
    const addresses = this.app.mustGetContracts(domain).addresses;
    await this.checkProxiedContract(domain, 'BridgeToken', addresses.token);
    await this.checkProxiedContract(domain, 'BridgeRouter', addresses.router);
  }

  checkEthHelper(domain: types.Domain): void {
    const helper = this.app.mustGetContracts(domain).helper;
    if (this.config.weth[this.app.mustResolveDomainName(domain)]) {
      expect(helper).to.not.be.undefined;
    } else {
      expect(helper).to.be.undefined;
    }
  }

  mustGetRouter(domain: types.Domain): BridgeRouter {
    return this.app.mustGetContracts(domain).router;
  }
}
