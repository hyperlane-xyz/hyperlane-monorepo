import { HyperlaneRouterChecker } from '../../router/HyperlaneRouterChecker.js';

import { InterchainAccount } from './InterchainAccount.js';
import { InterchainAccountConfig } from './InterchainAccountDeployer.js';
import { InterchainAccountFactories } from './contracts.js';

export class InterchainAccountChecker extends HyperlaneRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {}
