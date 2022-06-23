import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, chainNames, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-5ef2129',
    },
    runEnv: environment,
    namespace: environment,
    chains: chainNames,
  },
};
