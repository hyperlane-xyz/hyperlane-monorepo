import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-4d94b34',
    },
    cronSchedule: '0 15 * * *', // Every day at 3:00 PM UTC
    chainsToSkip: ['ethereum'],
    runEnv: environment,
    namespace: environment,
  },
};
