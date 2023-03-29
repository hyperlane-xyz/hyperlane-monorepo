import { AgentConnectionType, chainMetadata } from '@hyperlane-xyz/sdk';

import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import { GasPaymentEnforcementPolicyType } from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { helloworldMatchingList, routerMatchingList } from '../../utils';

import { chainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import interchainQueryRouters from './middleware/queries/addresses.json';
import { validators } from './validators';

const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);

const interchainQueriesMatchingList = routerMatchingList(
  interchainQueryRouters,
);

export const hyperlane: AgentConfig = {
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '5bf8aed-20230323-125721',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: AgentConnectionType.HttpQuorum,
  validators,
  relayer: {
    default: {
      blacklist: [
        ...releaseCandidateHelloworldMatchingList,
        {
          originDomain: 137,
          recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
        },
      ],
      gasPaymentEnforcement: [
        {
          type: GasPaymentEnforcementPolicyType.None,
          // To continue relaying interchain query callbacks, we whitelist
          // all messages between interchain query routers.
          // This whitelist will become more strict with
          // https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/1605
          matchingList: interchainQueriesMatchingList,
        },
        {
          type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        },
      ],
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const releaseCandidate: AgentConfig = {
  namespace: environment,
  runEnv: environment,
  context: Contexts.ReleaseCandidate,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '5bf8aed-20230323-125721',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: AgentConnectionType.HttpFallback,
  relayer: {
    default: {
      whitelist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcement: [
        {
          type: GasPaymentEnforcementPolicyType.None,
          matchingList: interchainQueriesMatchingList,
        },
        {
          type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        },
      ],
      transactionGasLimit: 750000,
      // Skipping arbitrum because the gas price estimates are inclusive of L1
      // fees which leads to wildly off predictions.
      skipTransactionGasLimitFor: [chainMetadata.arbitrum.chainId],
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
