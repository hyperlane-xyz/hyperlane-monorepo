import { AgentConfig } from '../../../src/config';

import { DevNetworks, domainNames } from './domains';
import { validators } from './validators';

export const agent: AgentConfig<DevNetworks> = {
  environment: 'dev',
  namespace: 'dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-f78e79a',
  },
  domainNames,
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
