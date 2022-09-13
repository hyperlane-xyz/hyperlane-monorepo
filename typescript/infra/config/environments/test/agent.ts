import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { TestChains, chainNames } from './chains';
import { validators } from './validators';

export const hyperlane: AgentConfig<TestChains> = {
  environment: 'test',
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  connectionType: ConnectionType.Http,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 0,
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
