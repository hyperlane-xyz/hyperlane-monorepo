import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { InterchainAccountFactories } from './contracts';

export class InterchainAccountChecker extends ProxiedRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {}
