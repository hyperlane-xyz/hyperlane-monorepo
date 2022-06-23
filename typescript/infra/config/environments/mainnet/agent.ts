import { AgentConfig } from '../../../src/config';

import { MainnetChains, chainNames, environment } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-4b9faad',
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
    chainOverrides: {
      celo: {
        reorgPeriod: 0,
      },
      ethereum: {
        reorgPeriod: 7,
      },
      bsc: {
        reorgPeriod: 7,
      },
      optimism: {
        reorgPeriod: 1,
      },
      arbitrum: {
        reorgPeriod: 1,
      },
      avalanche: {
        reorgPeriod: 0,
      },
      polygon: {
        reorgPeriod: 500,
      },
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
      interval: 60 * 60,
      chat: {
        type: 'static',
        message: '',
        recipient: '',
      },
    },
  },
};
