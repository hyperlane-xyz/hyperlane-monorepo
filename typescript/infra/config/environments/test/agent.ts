import {
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import { RootAgentConfig } from '../../../src/config/agent/agent.js';
import { ALL_KEY_ROLES } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agentChainNames, testChainNames } from './chains.js';
import { validators } from './validators.js';

const roleBase = {
  docker: {
    repo: 'ghcr.io/hyperlane-xyz/hyperlane-agent',
    tag: 'c558a9f-20260304-105241',
  },
  rpcConsensusType: RpcConsensusType.Single,
} as const;

const hyperlane: RootAgentConfig = {
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  contextChainNames: agentChainNames,
  environmentChainNames: testChainNames,
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
