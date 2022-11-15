import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import {
  MATCHING_LIST_ALL_WILDCARDS, //  helloworldMatchingList,
} from '../../utils';

import { TestnetChains, chainNames, environment } from './chains';
// import { helloWorld } from './helloworld';
import { validators } from './validators';

/*
const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);
*/

export const hyperlane: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/hyperlane-labs-dev/hyperlane-agent',
    tag: 'sha-7956ff0',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: ['alfajores', 'mumbai', 'goerli'],
  },
  connectionType: ConnectionType.HttpQuorum,
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
      mumbai: {
        reorgPeriod: 32,
      },
      bsctestnet: {
        reorgPeriod: 9,
      },
      goerli: {
        reorgPeriod: 3,
      },
      moonbasealpha: {
        reorgPeriod: 0,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      // blacklist: releaseCandidateHelloworldMatchingList,
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
    repo: 'gcr.io/hyperlane-labs-dev/hyperlane-agent',
    tag: 'sha-7956ff0',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: ['alfajores'],
  validatorSets: validators,
  gelato: {
    enabledChains: ['alfajores'],
  },
  connectionType: ConnectionType.HttpQuorum,
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
    repo: 'gcr.io/hyperlane-labs-dev/hyperlane-agent',
    tag: 'sha-7956ff0',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: ['alfajores', 'mumbai', 'goerli'],
  },
  connectionType: ConnectionType.HttpQuorum,
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      // Only process messages between the release candidate helloworld routers
      // whitelist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.Flowcarbon]: flowcarbon,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
