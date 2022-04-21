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
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  validatorSets: validators,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 1,
    },
    chainOverrides: {},
  },
  relayer: {
    default: {
      pollingInterval: 5,
      submissionLatency: 10,
      maxRetries: 10,
      relayerMessageProcessing: true,
    },
    chainOverrides: {
      alfajores: {
        pollingInterval: 5,
        submissionLatency: 10,
      },
      kovan: {
        pollingInterval: 5,
        submissionLatency: 10,
      },
    },
  },
  checkpointer: {
    default: {
      pollingInterval: 5,
      creationLatency: 10,
    },
    chainOverrides: {},
  },
};
