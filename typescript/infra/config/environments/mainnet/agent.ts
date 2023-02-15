import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { helloworldMatchingList } from '../../utils';

import { MainnetChains, chainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import { validators } from './validators';

const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);

export const abacus: AgentConfig<MainnetChains> = {
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
      // 'bsc',
      // 'ethereum',
      // 'polygon',
      // 'avalanche',
      // 'arbitrum',
      // 'optimism',
    ],
  },
  connectionType: ConnectionType.HttpFallback,
  validator: {
    default: {
      interval: 10,
      reorgPeriod: 1,
    },
    chainOverrides: {
      celo: {
        reorgPeriod: 0,
      },
      ethereum: {
        reorgPeriod: 20,
      },
      bsc: {
        reorgPeriod: 15,
      },
      optimism: {
        reorgPeriod: 0,
      },
      arbitrum: {
        reorgPeriod: 0,
      },
      avalanche: {
        reorgPeriod: 3,
      },
      polygon: {
        reorgPeriod: 256,
      },
      moonbeam: {
        reorgPeriod: 0,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      whitelist: [
        // Allow bidirectional messaging between Polygon/Celo Toucan contracts
        {
          sourceAddress: '0xABaC3D6b281Bbe0Fc0F67b26247cB27994eaAcaf',
          sourceDomain: '1667591279', // celo
          destinationAddress: '0xABaC3D6b281Bbe0Fc0F67b26247cB27994eaAcaf',
          destinationDomain: '1886350457', // polygon
        },
        {
          sourceAddress: '0xABaC3D6b281Bbe0Fc0F67b26247cB27994eaAcaf',
          sourceDomain: '1886350457', // polygon
          destinationAddress: '0xABaC3D6b281Bbe0Fc0F67b26247cB27994eaAcaf',
          destinationDomain: '1667591279', // celo
        },
        // Allow bidirectional messaging between Polygon/Celo Helloworld contracts
        {
          sourceAddress: '0x37fcf9DAEFAb05939c6e299c1AB8e7430A5715c8',
          sourceDomain: '1667591279', // celo
          destinationAddress: '0xb3eCff91A3C3FB1A2F57DE2881a0Cab7b56E129b',
          destinationDomain: '1886350457', // polygon
        },
        {
          sourceAddress: '0xb3eCff91A3C3FB1A2F57DE2881a0Cab7b56E129b',
          sourceDomain: '1886350457', // polygon
          destinationAddress: '0x37fcf9DAEFAb05939c6e299c1AB8e7430A5715c8',
          destinationDomain: '1667591279', // celo
        },
      ],
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const releaseCandidate: AgentConfig<MainnetChains> = {
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
      // 'bsc',
      // 'ethereum',
      // 'polygon',
      // 'avalanche',
      // 'arbitrum',
      // 'optimism',
    ],
  },
  connectionType: ConnectionType.HttpFallback,
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
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
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
