import { AgentConfig } from '../../../src/config';

import { DevChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<DevChains> = {
  environment: 'dev',
  namespace: 'dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-7be078e',
  },
  chainNames,
  validatorSets: validators,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 1,
    },
  },
  relayer: {
    default: {
      pollingInterval: 5,
      submissionLatency: 10,
      maxRetries: 10,
      relayerMessageProcessing: true,
      gelatoSupported: {
        alfajores: false,
        kovan: false,
      },
    },
  },
  checkpointer: {
    default: {
      pollingInterval: 5,
      creationLatency: 10,
    },
  },
  kathy: {
    default: {
      interval: 30,
    },
    chainOverrides: {
      kovan: {
        interval: 120,
      },
    },
  },
};
