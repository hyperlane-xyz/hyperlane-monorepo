import { AgentConfig } from '../../../src/config';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { TestnetNetworks, domainNames } from './domains';
import { validators } from './validators';

export const agent: AgentConfig<TestnetNetworks> = {
  environment: ENVIRONMENTS_ENUM.Testnet,
  namespace: ENVIRONMENTS_ENUM.Testnet,
  runEnv: ENVIRONMENTS_ENUM.Testnet,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'f30aa0a68a645bf966638e145ba8a4e15f80280e',
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
  },
  relayer: {
    default: {
      pollingInterval: 5,
      submissionLatency: 10,
      maxRetries: 10,
      relayerMessageProcessing: true,
    },
  },
  checkpointer: {
    default: {
      pollingInterval: 5,
      creationLatency: 10,
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
