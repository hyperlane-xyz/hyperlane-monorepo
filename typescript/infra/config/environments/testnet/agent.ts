import { AgentConfig } from '../../../src/config';

import { TestnetChains, chainNames } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<TestnetChains> = {
  environment: 'testnet',
  namespace: 'testnet',
  runEnv: 'testnet',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-7be078e',
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
      pollingInterval: 5,
      submissionLatency: 10,
      maxRetries: 10,
      relayerMessageProcessing: true,
    },
  },
  // kathy: {
  //   default: {
  //     interval: 30,
  //   },
  //   chainOverrides: {
  //     kovan: {
  //       interval: 120,
  //     },
  //   },
  // },
};
