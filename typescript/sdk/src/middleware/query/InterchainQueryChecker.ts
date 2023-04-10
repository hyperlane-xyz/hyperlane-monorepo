import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker';

import { InterchainQuery } from './InterchainQuery';
import { InterchainQueryConfig } from './InterchainQueryDeployer';
import { InterchainQueryFactories } from './contracts';

export class InterchainQueryChecker extends ProxiedRouterChecker<
  InterchainQueryFactories,
  InterchainQuery,
  InterchainQueryConfig
> {}
