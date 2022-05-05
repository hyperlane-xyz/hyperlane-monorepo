import { AgentConfig } from '../../../src/config';
import { domainNames, TestnetNetworks } from './domains';
import { validators } from './validators';

export const agent: AgentConfig<TestnetNetworks> = {
  environment: 'testnet',
  namespace: 'testnet',
  runEnv: 'testnet',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'b7ea3edee7d8d6557ae2ba830c2972586d4687fa',
  },
  aws: {
    region: 'us-east-1',
  },
  domainNames,
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
