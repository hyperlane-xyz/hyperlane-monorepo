import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainQuery } from './InterchainQuery';
import { InterchainQueryConfig } from './InterchainQueryDeployer';
import { interchainQueryFactories } from './contracts';

export class InterchainQueryChecker extends MiddlewareRouterChecker<
  typeof interchainQueryFactories,
  InterchainQuery,
  InterchainQueryConfig
> {}
