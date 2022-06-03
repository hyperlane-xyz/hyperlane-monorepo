import { AgentConfig } from '../../../src/config';

import { TestChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<TestChains> = {
  environment: 'test',
  namespace: 'test',
  runEnv: 'test',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  chainNames,
  validatorSets: validators,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 0,
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
};
