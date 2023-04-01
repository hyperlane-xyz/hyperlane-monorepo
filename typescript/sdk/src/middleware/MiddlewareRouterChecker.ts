import { HyperlaneRouterChecker } from '../router/HyperlaneRouterChecker';
import { RouterApp } from '../router/RouterApps';
import { ProxiedFactories, RouterConfig } from '../router/types';
import { ChainName } from '../types';

export abstract class MiddlewareRouterChecker<
  Factories extends ProxiedFactories,
  MiddlewareRouterApp extends RouterApp<Factories>,
  MiddlewareRouterConfig extends RouterConfig,
> extends HyperlaneRouterChecker<
  Factories,
  MiddlewareRouterApp,
  MiddlewareRouterConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkProxiedContracts(chain);
  }
}
