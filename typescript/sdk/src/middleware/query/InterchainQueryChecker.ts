import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainQuery } from './InterchainQuery';
import { InterchainQueryConfig } from './InterchainQueryDeployer';
import { InterchainQueryFactories } from './contracts';

export class InterchainQueryChecker extends MiddlewareRouterChecker<
  InterchainQueryFactories,
  InterchainQuery,
  InterchainQueryConfig
> {}
