import { AbacusRouterChecker } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { HelloWorldApp } from '../sdk/app';
import { HelloWorldContracts } from '../sdk/contracts';
import { HelloWorldConfig } from './config';

export class HelloWorldChecker<
  Chain extends ChainName,
> extends AbacusRouterChecker<
  Chain,
  HelloWorldContracts,
  HelloWorldApp<Chain>,
  HelloWorldConfig
> {}
