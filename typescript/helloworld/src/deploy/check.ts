import { HyperlaneRouterChecker } from '@hyperlane-xyz/sdk';

import { type HelloWorldApp } from '../app/app.js';
import { type HelloWorldFactories } from '../app/contracts.js';

import { type HelloWorldConfig } from './config.js';

export class HelloWorldChecker extends HyperlaneRouterChecker<
  HelloWorldFactories,
  HelloWorldApp,
  HelloWorldConfig
> {}
