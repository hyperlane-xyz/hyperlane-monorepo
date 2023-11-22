import {
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { RootAgentConfig, allAgentChainNames } from '../../../src/config';
import { GasPaymentEnforcementConfig } from '../../../src/config/agent/relayer';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { agentChainNames, environment } from './chains';
import { validatorChainConfig } from './validators';

// const releaseCandidateHelloworldMatchingList = routerMatchingList(
//   helloWorld[Contexts.ReleaseCandidate].addresses,
// );

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

const contextBase = {
  namespace: environment,
  runEnv: environment,
  contextChainNames: agentChainNames,
  environmentChainNames: allAgentChainNames(agentChainNames),
  aws: {
    region: 'us-east-1',
  },
} as const;

const gasPaymentEnforcement: GasPaymentEnforcementConfig[] = [
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

const hyperlane: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '1bee32a-20231121-121303',
    },
    gasPaymentEnforcement,
  },
  validators: {
    docker: {
      repo,
      tag: '1bee32a-20231121-121303',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '1bee32a-20231121-121303',
    },
  },
};

const releaseCandidate: RootAgentConfig = {
  ...contextBase,
  context: Contexts.ReleaseCandidate,
  rolesWithKeys: [Role.Relayer, Role.Kathy, Role.Validator],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '35fdc74-20230913-104940',
    },
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrum.name],
  },
  validators: {
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
