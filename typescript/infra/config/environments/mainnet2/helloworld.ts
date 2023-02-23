import { HelloWorldConfig } from '../../../src/config';
import { ConnectionType } from '../../../src/config/agent';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { Contexts } from '../../contexts';

import { environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlane: HelloWorldConfig = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '83ec4f0-20230216-122421',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 8, // every 8 hours
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: ConnectionType.HttpFallback,
    cyclesBetweenEthereumMessages: 3, // Skip 3 cycles of Ethereum, i.e. send/receive Ethereum messages every 32 hours.
  },
};

export const releaseCandidate: HelloWorldConfig = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '83ec4f0-20230216-122421',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: ConnectionType.Http,
  },
};

export const helloWorld: Partial<Record<Contexts, HelloWorldConfig>> = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
