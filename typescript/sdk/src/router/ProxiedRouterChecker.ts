import { ChainName } from '../types';

import { HyperlaneRouterChecker } from './HyperlaneRouterChecker';
import { RouterApp } from './RouterApps';
import { ProxiedFactories, RouterConfig } from './types';

export abstract class ProxiedRouterChecker<
  Factories extends ProxiedFactories,
  App extends RouterApp<Factories>,
  Config extends RouterConfig,
> extends HyperlaneRouterChecker<Factories, App, Config> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkProxiedContracts(chain);
  }
}
