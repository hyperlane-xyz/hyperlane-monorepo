import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-3e4a570',
    },
    cronSchedule: '0 */2 * * *', // Once every 2 hours
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
  },
};
