import { HyperlaneRouterChecker } from '../router/HyperlaneRouterChecker';

import { HypERC20App } from './app';
import { HypERC20Config } from './config';
import { HypERC20Factories } from './contracts';

export class HypERC20Checker extends HyperlaneRouterChecker<
  HypERC20Factories,
  HypERC20App,
  HypERC20Config
> {}
