import { AgentConfig } from '../../../src/config';

import { DevChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<DevChains> = {
  environment: 'dev',
  namespace: 'dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-5e639a2',
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
      signedCheckpointPollingInterval: 5,
      maxProcessingRetries: 10,
    },
  },
  kathy: {
    default: {
      enabled: false,
      interval: 60 * 2,
      chat: {
        type: 'static',
        message: '',
        recipient: '',
      },
    },
  },
};
