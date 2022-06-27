import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-0f9c0f9',
    },
    cronSchedule: '0 * * * *', // Once every hour
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
  },
};
