import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { MainnetChains, chainNames, environment } from './chains';
// import { helloWorld } from './helloworld';
import { validators } from './validators';

export const hyperlane: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: 'sha-275771b',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [],
  },
  connectionType: ConnectionType.HttpQuorum,
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
      moonbeam: {
        reorgPeriod: 0,
      },
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
