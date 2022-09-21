import { RouterContracts, RouterFactories } from '@hyperlane-xyz/sdk';

import { HelloWorld, HelloWorld__factory } from '../types';

export type HelloWorldFactories = RouterFactories<HelloWorld>;

export const helloWorldFactories: HelloWorldFactories = {
  router: new HelloWorld__factory(),
};

export type HelloWorldContracts = RouterContracts<HelloWorld>;
