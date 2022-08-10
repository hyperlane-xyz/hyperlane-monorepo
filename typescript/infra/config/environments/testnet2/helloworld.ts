import { HelloWorldConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { TestnetChains, environment } from './chains';
import abacusAddresses from './helloworld/abacus/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const abacus: HelloWorldConfig<TestnetChains> = {
  addresses: abacusAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1d4c40e',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    fullCycleTime: 1000 * 60 * 60 * 2, // every 2 hours
    messageSendTimeout: 1000 * 60 * 15, // 15 min
    messageReceiptTimeout: 1000 * 60 * 15, // 15 min
  },
};

export const rc: HelloWorldConfig<TestnetChains> = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-a621485',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    fullCycleTime: 1000 * 60 * 60 * 2, // every 2 hours
    messageSendTimeout: 1000 * 60 * 15, // 15 min
    messageReceiptTimeout: 1000 * 60 * 15, // 15 min
  },
};

export const helloWorld: Partial<
  Record<Contexts, HelloWorldConfig<TestnetChains>>
> = {
  [Contexts.Abacus]: abacus,
  [Contexts.ReleaseCandidate]: rc,
};
