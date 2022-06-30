import { AgentConfig } from '../../../src/config';

import { TestnetChains, chainNames, environment } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-de20710',
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
      alfajores: {
        reorgPeriod: 0,
      },
      fuji: {
        reorgPeriod: 0,
      },
      kovan: {
        reorgPeriod: 7,
      },
      mumbai: {
        reorgPeriod: 32,
      },
      bsctestnet: {
        reorgPeriod: 9,
      },
      arbitrumrinkeby: {
        reorgPeriod: 1,
      },
      optimismkovan: {
        reorgPeriod: 1,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      maxProcessingRetries: 10,
    },
  },
};
