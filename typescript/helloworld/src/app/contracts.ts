import { HelloWorld__factory } from './helloWorldFactory.js';

export const helloWorldFactories = {
  router: new HelloWorld__factory(),
};

export type HelloWorldFactories = typeof helloWorldFactories;
