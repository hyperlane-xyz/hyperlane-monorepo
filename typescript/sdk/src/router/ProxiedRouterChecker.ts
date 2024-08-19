import { ChainName } from '../types.js';

import { HyperlaneRouterChecker } from './HyperlaneRouterChecker.js';
import { RouterApp } from './RouterApps.js';
import { ProxiedFactories, ProxiedRouterConfig } from './types.js';

export abstract class ProxiedRouterChecker<
  Factories extends ProxiedFactories,
  App extends RouterApp<Factories>,
  Config extends ProxiedRouterConfig,
> extends HyperlaneRouterChecker<Factories, App, Config> {
  getOwnableOverrides(chain: ChainName): any {
    const config = this.configMap[chain];
    if (config.timelock) {
      return {
        proxyAdmin: this.app.getAddresses(chain).timelockController,
      };
    }
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

  async checkChain(chain: ChainName): Promise<void> {
    await super.checkMailboxClient(chain);
    await super.checkEnrolledRouters(chain);
    await this.checkProxiedContracts(chain);
    await this.checkOwnership(chain);
  }
}
