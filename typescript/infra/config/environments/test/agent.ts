import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import {
  AgentConfig,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config';
import { ALL_KEY_ROLES } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { chainNames } from './chains';
import { validators } from './validators';

const hyperlaneBase = {
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: AgentConnectionType.Http,
  rolesWithKeys: ALL_KEY_ROLES,
} as const;

const hyperlane: AgentConfig = {
  other: hyperlaneBase,
  relayer: {
    ...hyperlaneBase,
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
      },
    ],
  },
  validators: {
    ...hyperlaneBase,
    chains: validators,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
