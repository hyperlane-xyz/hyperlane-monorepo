import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainQuery } from './InterchainQuery';
import { InterchainQueryConfig } from './InterchainQueryDeployer';
import { InterchainQueryContracts } from './contracts';

export class InterchainQueryChecker extends MiddlewareRouterChecker<
  InterchainQuery,
  InterchainQueryConfig,
  InterchainQueryContracts
> {}
