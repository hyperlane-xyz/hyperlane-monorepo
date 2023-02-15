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
    tag: 'sha-f8bcf0a',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [
      // 'alfajores',
      // 'mumbai',
      // 'goerli',
    ],
  },
  connectionType: ConnectionType.HttpFallback,
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
        reorgPeriod: 3,
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
      whitelist: [
        // Allow bidirectional messaging between Mumbai/Alfajores Toucan contracts
        {
          sourceAddress: '0xdb45A8869f94c15954e282F28e272f5597063e9A',
          sourceDomain: 'alfajores',
          destinationAddress: '0xf9a49993DF24366AB8EDf617C080ca36a4ADb86e',
          destinationDomain: 'mumbai',
        },
        {
          sourceAddress: '0xf9a49993DF24366AB8EDf617C080ca36a4ADb86e',
          sourceDomain: 'mumbai',
          destinationAddress: '0xdb45A8869f94c15954e282F28e272f5597063e9A',
          destinationDomain: 'alfajores',
        },
        // Allow bidirectional messaging between Mumbai/Alfajores Helloworld contracts
        {
          sourceAddress: '0x0FD5A339466638aD2746748dCfFF65A27f605de4',
          sourceDomain: 'alfajores',
          destinationAddress: '0x636bcE43104Ef1E61e93E84F0A324d037C258308',
          destinationDomain: 'mumbai',
        },
        {
          sourceAddress: '0x636bcE43104Ef1E61e93E84F0A324d037C258308',
          sourceDomain: 'mumbai',
          destinationAddress: '0x0FD5A339466638aD2746748dCfFF65A27f605de4',
          destinationDomain: 'alfajores',
        },
      ],
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
    tag: 'sha-f8bcf0a',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: ['alfajores'],
  validatorSets: validators,
  gelato: {
    enabledChains: [
      // 'alfajores',
    ],
  },
  connectionType: ConnectionType.HttpFallback,
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
    tag: 'sha-f8bcf0a',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [
      // 'alfajores',
      // 'mumbai',
      // 'goerli',
    ],
  },
  connectionType: ConnectionType.HttpFallback,
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
