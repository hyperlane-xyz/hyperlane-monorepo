import { HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { Contexts } from '../../contexts';

import { TestnetChains, environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlane: HelloWorldConfig<TestnetChains> = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1c67fc9',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 2, // every 2 hours
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
  },
};

export const releaseCandidate: HelloWorldConfig<TestnetChains> = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-1c67fc9',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
  },
};

export const helloWorld: Partial<
  Record<Contexts, HelloWorldConfig<TestnetChains>>
> = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
