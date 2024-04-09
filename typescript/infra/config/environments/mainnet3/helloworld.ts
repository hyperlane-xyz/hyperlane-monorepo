import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import {
  HelloWorldConfig,
  HelloWorldKathyRunMode,
} from '../../../src/config/helloworld/types.js';
import { Contexts } from '../../contexts.js';

import { environment } from './chains.js';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlane: HelloWorldConfig = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '86b7f98-20231207-153806',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 24 * 5, // every 5 days, 13 * 12 messages = 156 messages is little less than once an hour
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: RpcConsensusType.Fallback,
    cyclesBetweenEthereumMessages: 1, // Skip 1 cycle of Ethereum, i.e. send/receive Ethereum messages every 5 days (not great since we still send like 12 in that cycle)
  },
};

export const releaseCandidate: HelloWorldConfig = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '0e3f73f-20240206-160718',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: RpcConsensusType.Fallback,
  },
};

export const helloWorld = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: undefined,
};
