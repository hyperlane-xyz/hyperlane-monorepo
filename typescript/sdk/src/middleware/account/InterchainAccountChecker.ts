import { MiddlewareRouterChecker } from '../MiddlewareRouterChecker';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { InterchainAccountContracts } from './contracts';

export class InterchainAccountChecker extends MiddlewareRouterChecker<
  InterchainAccount,
  InterchainAccountConfig,
  InterchainAccountContracts
> {}
