import { AgentConfig } from '../../../src/config';

import { TestnetChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<TestnetChains> = {
  environment: 'testnet2',
  namespace: 'testnet2',
  runEnv: 'testnet2',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-0b525b2',
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
      optimismkovan: {
        interval: 5,
        reorgPeriod: 2,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInteral: 5,
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
    chainOverrides: {
      alfajores: {
        enabled: true,
        interval: 60 * 2,
        chat: {
          type: 'static',
          message: 'f00',
          recipient:
            '0x000000000000000000000000d0d0ff5589da9b43031f8adf576b08476f587191',
        },
      },
    },
  },
};
