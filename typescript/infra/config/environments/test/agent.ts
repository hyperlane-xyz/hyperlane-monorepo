import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import {
  GasPaymentEnforcementPolicyType,
  RootAgentConfig,
} from '../../../src/config';
import { ALL_KEY_ROLES } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { chainNames } from './chains';
import { validators } from './validators';

const roleBase = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  connectionType: AgentConnectionType.Http,
} as const;

const hyperlane: RootAgentConfig = {
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  contextChainNames: chainNames,
  environmentChainNames: chainNames,
  relayer: {
    ...roleBase,
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
      },
    ],
  },
  validators: {
    ...roleBase,
    chains: validators,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
