import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-d2345ab',
    },
    cronSchedule: '19 * * * *', // At the beginning of each hour
    chainsToSkip: ['ethereum'],
    runEnv: environment,
    namespace: environment,
  },
};
