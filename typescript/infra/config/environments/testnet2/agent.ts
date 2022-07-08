import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';

import { TestnetChains, chainNames, environment } from './chains';
import { validators } from './validators';

enum Contexts {
  Abacus = 'abacus',
  Flowcarbon = 'flowcarbon',
}

export const abacus: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Abacus,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-8740021',
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
      alfajores: {
        reorgPeriod: 1,
      },
      fuji: {
        reorgPeriod: 1,
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
  rolesWithKeys: ALL_KEY_ROLES,
};

export const flowcarbon: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Flowcarbon,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-8740021',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: ['alfajores', 'kovan'],
  validatorSets: validators,
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      maxProcessingRetries: 10,
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer],
};

export const agents: Record<Contexts, AgentConfig<TestnetChains>> = {
  abacus,
  flowcarbon,
};
