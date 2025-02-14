import { AddressesMap, HyperlaneContracts } from '../contracts/types.js';
import { ChainName } from '../types.js';

import { HyperlaneRouterChecker } from './HyperlaneRouterChecker.js';
import { RouterApp } from './RouterApps.js';
import { ProxiedFactories, ProxiedRouterConfig } from './types.js';

export abstract class ProxiedRouterChecker<
  Factories extends ProxiedFactories,
  App extends RouterApp<Factories>,
  Config extends ProxiedRouterConfig,
> extends HyperlaneRouterChecker<Factories, App, Config> {
  getOwnableOverrides(chain: ChainName): AddressesMap | undefined {
    const config = this.configMap[chain];
    let ownableOverrides = config?.ownerOverrides;
    if (config?.timelock) {
      ownableOverrides = {
        ...ownableOverrides,
        proxyAdmin: this.app.getAddresses(chain).timelockController,
      };
    }
    return ownableOverrides;
  }

  async checkOwnership(chain: ChainName): Promise<void> {
    return super.checkOwnership(
      chain,
      this.configMap[chain].owner,
      this.getOwnableOverrides(chain),
    );
  }

  async proxiedContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<Factories>> {
    return this.app.getContracts(chain);
  }

  async checkProxiedContracts(chain: ChainName): Promise<void> {
    return super.checkProxiedContracts(
      chain,
      this.configMap[chain].owner,
      this.getOwnableOverrides(chain),
      this.proxiedContracts(chain),
    );
  }

  async checkChain(chain: ChainName): Promise<void> {
    await super.checkMailboxClient(chain);
    await super.checkEnrolledRouters(chain);
    await this.checkProxiedContracts(chain);
    await this.checkOwnership(chain);
  }
}
