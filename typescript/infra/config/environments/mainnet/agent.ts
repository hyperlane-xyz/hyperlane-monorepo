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

export const hyperlane: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-58984b5',
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

export const releaseCandidate: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.ReleaseCandidate,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-58984b5',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  connectionType: ConnectionType.Http,
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
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
