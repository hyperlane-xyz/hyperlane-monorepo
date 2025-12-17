import { type AddressesMap } from '../contracts/types.js';
import { type ChainName } from '../types.js';

import { HyperlaneRouterChecker } from './HyperlaneRouterChecker.js';
import { type RouterApp } from './RouterApps.js';
import { type ProxiedFactories, type ProxiedRouterConfig } from './types.js';

export abstract class ProxiedRouterChecker<
  Factories extends ProxiedFactories,
  App extends RouterApp<Factories>,
  Config extends ProxiedRouterConfig,
> extends HyperlaneRouterChecker<Factories, App, Config> {
  getOwnableOverrides(chain: ChainName): AddressesMap | undefined {
    const config = this.configMap[chain];
    let ownableOverrides = config?.ownerOverrides;
    // timelock and proxyAdmin are mutally exclusive
    if (config?.timelock) {
      ownableOverrides = {
        ...ownableOverrides,
        proxyAdmin: this.app.getAddresses(chain).timelockController,
      };
    } else if (config?.proxyAdmin) {
      ownableOverrides = {
        ...ownableOverrides,
        proxyAdmin: config.proxyAdmin.owner,
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

  async checkProxiedContracts(chain: ChainName): Promise<void> {
    return super.checkProxiedContracts(
      chain,
      this.configMap[chain].owner,
      this.getOwnableOverrides(chain),
    );
  }

  async checkChain(
    chain: ChainName,
    expectedChains?: ChainName[],
  ): Promise<void> {
    await super.checkMailboxClient(chain);
    await super.checkEnrolledRouters(chain, expectedChains);
    await this.checkProxiedContracts(chain);
    await this.checkOwnership(chain);
  }
}
