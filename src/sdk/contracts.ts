import {
  AbacusContracts,
  RouterAddresses,
  routerFactories,
} from '@abacus-network/sdk';
import { Yo__factory } from '../types';

export type YoAddresses = RouterAddresses;

export const yoFactories = {
  ...routerFactories,
  router: Yo__factory.connect,
};

export type YoFactories = typeof yoFactories;

export class YoContracts extends AbacusContracts<YoAddresses, YoFactories> {
  // necessary for factories be defined in the constructor
  factories() {
    return yoFactories;
  }
}
