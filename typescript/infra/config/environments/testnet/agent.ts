import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';

import { TestnetChains, chainNames } from './chains';
import { validators } from './validators';

export const abacus: AgentConfig<TestnetChains> = {
  environment: 'testnet',
  namespace: 'testnet',
  runEnv: 'testnet',
  context: 'abacus',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-5e639a2',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
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
      signedCheckpointPollingInterval: 5,
      maxProcessingRetries: 10,
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  abacus,
};
