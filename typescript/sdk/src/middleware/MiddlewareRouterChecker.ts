import { HyperlaneContracts } from '../contracts';
import { HyperlaneRouterChecker } from '../router/HyperlaneRouterChecker';
import { RouterApp } from '../router/RouterApps';
import { RouterConfig } from '../router/types';
import { ChainName } from '../types';

export abstract class MiddlewareRouterChecker<
  MiddlewareRouterApp extends RouterApp<MiddlewareRouterContracts>,
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends HyperlaneContracts,
> extends HyperlaneRouterChecker<
  MiddlewareRouterApp,
  MiddlewareRouterConfig,
  MiddlewareRouterContracts
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkProxiedContracts(chain);
  }
}
