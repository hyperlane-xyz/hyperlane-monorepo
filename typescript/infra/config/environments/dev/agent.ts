import { AgentConfig } from '../../../src/config';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { DevNetworks } from './domains';
import { validators } from './validators';

export const agent: AgentConfig<DevNetworks> = {
  environment: ENVIRONMENTS_ENUM.Dev,
  namespace: ENVIRONMENTS_ENUM.Dev,
  runEnv: ENVIRONMENTS_ENUM.Dev,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: '8ee03796167efdf80daf6d7fc4673de47f8657f9',
  },
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
