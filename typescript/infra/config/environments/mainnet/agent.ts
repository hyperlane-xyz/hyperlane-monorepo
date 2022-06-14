import { AgentConfig } from '../../../src/config';

import { MainnetChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<MainnetChains> = {
  environment: 'mainnet',
  namespace: 'mainnet',
  runEnv: 'mainnet',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-d664980',
  },
  aws: {
    region: 'us-east-1',
  },
  chainNames: chainNames,
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
      enabled: true,
      interval: 60 * 60,
      chat: {
        type: 'static',
        message: 'f00',
        recipient:
          '0x000000000000000000000000d0d0ff5589da9b43031f8adf576b08476f587191',
      },
    },
  },
};
