import { AbacusRouterChecker } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { YoApp } from '../sdk';
import { YoConfig } from '../sdk/types';

export class YoChecker<Networks extends ChainName> extends AbacusRouterChecker<
  Networks,
  YoApp<Networks>,
  YoConfig
> {
  mustGetRouter(network: Networks) {
    return this.app.getContracts(network).router;
  }
}
