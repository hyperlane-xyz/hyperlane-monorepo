import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { chainNames } from './chains';
import { validators } from './validators';

export const hyperlane: AgentConfig = {
  environment: 'test',
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: ConnectionType.Http,
  validators,
  relayer: {
    default: {
      gasPaymentEnforcement: {
        policy: {
          type: GasPaymentEnforcementPolicyType.None,
        },
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
