import { ChainName, AbacusRouterChecker } from '@abacus-network/sdk';
import { HelloWorldApp } from '../app/app';
import { HelloWorldContracts } from '../app/contracts';
import { HelloWorldConfig } from './config';

export class HelloWorldChecker<
  Chain extends ChainName,
> extends AbacusRouterChecker<
  Chain,
  HelloWorldContracts,
  HelloWorldApp<Chain>,
  HelloWorldConfig
> {}
