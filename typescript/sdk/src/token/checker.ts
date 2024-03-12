import { HyperlaneRouterChecker } from '../router/HyperlaneRouterChecker';

import { HypERC20App } from './app';
import { ERC20RouterConfig } from './config';
import { HypERC20Factories } from './contracts';

export class HypERC20Checker extends HyperlaneRouterChecker<
  HypERC20Factories,
  HypERC20App,
  ERC20RouterConfig
> {}

// export class HelloWorldChecker extends HyperlaneRouterChecker<
//   HelloWorldFactories,
//   HelloWorldApp,
//   HelloWorldConfig
// > {}
