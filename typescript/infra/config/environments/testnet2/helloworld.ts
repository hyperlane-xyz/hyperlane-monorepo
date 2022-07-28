import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-f0c45a1',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    fullCycleTime: 1000 * 60 * 60 * 2, // every 2 hours
    messageSendTimeout: 1000 * 60 * 10, // 10 min
    messageReceiptTimeout: 1000 * 60 * 15, // 15 min
    maxSendRetries: 2,
  },
};
