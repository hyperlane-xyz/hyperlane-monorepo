import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker.js';

import { InterchainQuery } from './InterchainQuery.js';
import { InterchainQueryConfig } from './InterchainQueryDeployer.js';
import { InterchainQueryFactories } from './contracts.js';

export class InterchainQueryChecker extends ProxiedRouterChecker<
  InterchainQueryFactories,
  InterchainQuery,
  InterchainQueryConfig
> {}
