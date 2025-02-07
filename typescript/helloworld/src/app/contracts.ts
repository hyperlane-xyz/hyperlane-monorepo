import { HelloWorld__factory } from '../types/index.js';

export const helloWorldFactories = {
  router: new HelloWorld__factory(),
};

export type HelloWorldFactories = typeof helloWorldFactories;
