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
      tag: 'sha-66033e4',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    fullCycleTime: 1000 * 60 * 60 * 2, // every 2 hours
    messageSendTimeout: 1000 * 60 * 15, // 15 min
    messageReceiptTimeout: 1000 * 60 * 15, // 15 min
    cycleOnce: false,
  },
};

export const releaseCandidate: HelloWorldConfig<TestnetChains> = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-f0181ff',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    cycleOnce: true,
  },
};

export const helloWorld: Partial<
  Record<Contexts, HelloWorldConfig<TestnetChains>>
> = {
  [Contexts.Abacus]: abacus,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
