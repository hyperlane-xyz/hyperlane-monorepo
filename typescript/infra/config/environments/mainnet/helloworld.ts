import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1d4c40e',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    fullCycleTime: 1000 * 60 * 60 * 6, // every 6 hours
    messageSendTimeout: 1000 * 60 * 15, // 15 min
    messageReceiptTimeout: 1000 * 60 * 15, // 15 min
  },
};
