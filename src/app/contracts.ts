import { RouterContracts, RouterFactories } from '@abacus-network/sdk';
import { HelloWorld, HelloWorld__factory } from '../types';

export type HelloWorldFactories = RouterFactories<HelloWorld>;

export const helloWorldFactories: HelloWorldFactories = {
  router: new HelloWorld__factory(),
};

export type HelloWorldContracts = RouterContracts<HelloWorld>;
