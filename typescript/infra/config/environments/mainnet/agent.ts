import { AgentConfig } from '../../../src/config';

import { MainnetChains, chainNames, environment } from './chains';
import { validators } from './validators';

export const agent: AgentConfig<MainnetChains> = {
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
      celo: {
        reorgPeriod: 1,
      },
      ethereum: {
        reorgPeriod: 20,
      },
      bsc: {
        reorgPeriod: 15,
      },
      optimism: {
        reorgPeriod: 20,
      },
      arbitrum: {
        reorgPeriod: 1,
      },
      avalanche: {
        reorgPeriod: 1,
      },
      polygon: {
        reorgPeriod: 256,
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
