import { HyperlaneRouterChecker } from '@hyperlane-xyz/sdk';

import { HelloWorldApp } from '../app/app.js';
import { HelloWorldFactories } from '../app/contracts.js';

import { HelloWorldConfig } from './config.js';

export class HelloWorldChecker extends HyperlaneRouterChecker<
  HelloWorldFactories,
  HelloWorldApp,
  HelloWorldConfig
> {}
