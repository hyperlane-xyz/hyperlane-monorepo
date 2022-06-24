import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1603a7c',
    },
    cronSchedule: '0 * * * *', // At the beginning of each hour
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
  },
};
