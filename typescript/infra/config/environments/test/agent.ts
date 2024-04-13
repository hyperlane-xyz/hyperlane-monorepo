import {
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import { RootAgentConfig } from '../../../src/config/agent/agent.js';
import { ALL_KEY_ROLES } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agentChainNames, chainNames } from './chains.js';
import { validators } from './validators.js';

const roleBase = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  rpcConsensusType: RpcConsensusType.Single,
} as const;

const hyperlane: RootAgentConfig = {
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  contextChainNames: agentChainNames,
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
