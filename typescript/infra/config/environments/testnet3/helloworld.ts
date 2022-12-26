import { HelloWorldConfig } from '../../../src/config';
import { ConnectionType } from '../../../src/config/agent';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { Contexts } from '../../contexts';

import { TestnetChains, environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';

export const hyperlane: HelloWorldConfig<TestnetChains> = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: 'sha-6ee34e4',
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
    connectionType: ConnectionType.Http,
  },
};

export const helloWorld: Partial<
  Record<Contexts, HelloWorldConfig<TestnetChains>>
> = {
  [Contexts.Hyperlane]: hyperlane,
};
