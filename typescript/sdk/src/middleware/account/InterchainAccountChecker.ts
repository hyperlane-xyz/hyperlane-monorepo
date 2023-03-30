import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { interchainAccountFactories } from './contracts';

export class InterchainAccountChecker extends MiddlewareRouterChecker<
  typeof interchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {}
