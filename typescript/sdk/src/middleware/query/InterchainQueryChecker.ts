import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker.js';

import { type InterchainQuery } from './InterchainQuery.js';
import { type InterchainQueryConfig } from './InterchainQueryDeployer.js';
import { type InterchainQueryFactories } from './contracts.js';

export class InterchainQueryChecker extends ProxiedRouterChecker<
  InterchainQueryFactories,
  InterchainQuery,
  InterchainQueryConfig
> {}
