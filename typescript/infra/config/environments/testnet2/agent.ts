import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import {
  MATCHING_LIST_ALL_WILDCARDS,
  helloworldMatchingList,
} from '../../utils';

import { TestnetChains, chainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import { validators } from './validators';

const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);

export const abacus: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Abacus,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-33b82dc',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  connectionType: ConnectionType.Http,
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
        reorgPeriod: 3,
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
        reorgPeriod: 0,
      },
      optimismkovan: {
        reorgPeriod: 0,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      blacklist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
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
    tag: 'sha-33b82dc',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: ['alfajores', 'kovan'],
  validatorSets: validators,
  connectionType: ConnectionType.Http,
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      // Blacklist everything for now
      blacklist: MATCHING_LIST_ALL_WILDCARDS,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer],
};

export const releaseCandidate: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.ReleaseCandidate,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-3e60d9a',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  gelato: {
    enabledChains: ['alfajores', 'mumbai', 'kovan'],
    useForDisabledOriginChains: true,
  },
  validatorSets: validators,
  connectionType: ConnectionType.Http,
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      // Only process messages between the release candidate helloworld routers
      whitelist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
};

export const agents = {
  [Contexts.Abacus]: abacus,
  [Contexts.Flowcarbon]: flowcarbon,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
