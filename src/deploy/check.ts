import { HyperlaneRouterChecker } from '@hyperlane-xyz/sdk';

import { HelloWorldApp } from '../app/app';
import { HelloWorldContracts } from '../app/contracts';

import { HelloWorldConfig } from './config';

export class HelloWorldChecker extends HyperlaneRouterChecker<
  HelloWorldApp,
  HelloWorldConfig,
  HelloWorldContracts
> {}
