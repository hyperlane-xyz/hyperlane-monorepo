import { AgentConnectionType, chainMetadata } from '@hyperlane-xyz/sdk';

import {
  AgentConfig,
  GasPaymentEnforcementPolicyType,
  overrideBase,
  routerMatchingList,
} from '../../../src/config';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { chainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import interchainQueryRouters from './middleware/queries/addresses.json';
import { validators } from './validators';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const interchainQueriesMatchingList = routerMatchingList(
  interchainQueryRouters,
);

// const base = {
//   namespace: environment,
//   runEnv: environment,
//   docker: {
//     repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
//     tag: '40cc4a6-20230420-080111',
//   },
//   aws: {
//     region: 'us-east-1',
//   },
//   environmentChainNames: chainNames,
//   contextChainNames: chainNames,
//   connectionType: AgentConnectionType.HttpFallback,
//   rolesWithKeys: ALL_KEY_ROLES,
// } as const;

const hyperlane: AgentConfig = {
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '40cc4a6-20230420-080111',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: AgentConnectionType.HttpFallback,
  validators: overrideBase(validators, {
    connectionType: AgentConnectionType.HttpQuorum,
  }),
  relayer: {
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
  scraper: {},
  rolesWithKeys: ALL_KEY_ROLES,
};

const releaseCandidate: AgentConfig = {
  namespace: environment,
  runEnv: environment,
  context: Contexts.ReleaseCandidate,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '40cc4a6-20230420-080111',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  connectionType: AgentConnectionType.HttpFallback,
  relayer: {
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
  rolesWithKeys: [Role.Relayer, Role.Kathy],
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
