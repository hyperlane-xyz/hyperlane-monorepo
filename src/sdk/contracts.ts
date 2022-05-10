import {
  AbacusContracts,
  RouterAddresses,
  routerFactories,
} from '@abacus-network/sdk';
import { HelloWorld__factory } from '../types';

export type HelloWorldAddresses = RouterAddresses;

export const helloWorldFactories = {
  ...routerFactories,
  router: HelloWorld__factory.connect,
};

export type HelloWorldFactories = typeof helloWorldFactories;

export class HelloWorldContracts extends AbacusContracts<
  HelloWorldAddresses,
  HelloWorldFactories
> {
  // necessary for factories be defined in the constructor
  factories() {
    return helloWorldFactories;
  }
}
