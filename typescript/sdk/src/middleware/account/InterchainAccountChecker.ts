import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { InterchainAccountFactories } from './contracts';

export class InterchainAccountChecker extends MiddlewareRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {}
