import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld/types';
import { Contexts } from '../../contexts';

import { environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlaneHelloworld: HelloWorldConfig = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '5601743-20231007-124637',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 24, // every 24 hours
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: RpcConsensusType.Fallback,
  },
};

export const releaseCandidateHelloworld: HelloWorldConfig = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '5601743-20231007-124637',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: RpcConsensusType.Single,
  },
};

export const helloWorld = {
  [Contexts.Hyperlane]: hyperlaneHelloworld,
  [Contexts.ReleaseCandidate]: releaseCandidateHelloworld,
};
