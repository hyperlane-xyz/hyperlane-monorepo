import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, chainNames, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
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
