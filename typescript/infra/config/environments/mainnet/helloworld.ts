import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-6dc6f47',
    },
    cronSchedule: '32 * * * *', // At the beginning of each hour
    chainsToSkip: ['ethereum'],
    runEnv: environment,
    namespace: environment,
  },
};
