import { type InterchainAccountConfig } from '../../index.js';
import { HyperlaneRouterChecker } from '../../router/HyperlaneRouterChecker.js';

import { type InterchainAccount } from './InterchainAccount.js';
import { type InterchainAccountFactories } from './contracts.js';

export class InterchainAccountChecker extends HyperlaneRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {}
