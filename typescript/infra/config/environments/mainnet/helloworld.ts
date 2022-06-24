import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1603a7c',
    },
    cronSchedule: '55 * * * *', // At the beginning of each hour
    chainsToSkip: ['ethereum'],
    runEnv: environment,
    namespace: environment,
  },
};
