import { AbacusRouterChecker } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { HelloWorldApp } from '../sdk';
import { HelloWorldConfig } from '../sdk/types';

export class HelloWorldChecker<
  Networks extends ChainName,
> extends AbacusRouterChecker<
  Networks,
  HelloWorldApp<Networks>,
  HelloWorldConfig
> {
  mustGetRouter(network: Networks) {
    return this.app.getContracts(network).router;
  }
}
