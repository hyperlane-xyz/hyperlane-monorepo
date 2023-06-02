import { AgentConnectionType, chainMetadata } from '@hyperlane-xyz/sdk';

import {
  AgentConfig,
  GasPaymentEnforcementPolicyType,
  routerMatchingList,
} from '../../../src/config';
import { GasPaymentEnforcementConfig } from '../../../src/config/agent/relayer';
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

const base = {
  namespace: environment,
  runEnv: environment,
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
} as const;

const gasPaymentEnforcement: GasPaymentEnforcementConfig[] = [
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
];

const hyperlaneBase = {
  ...base,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
};

const hyperlane: AgentConfig = {
  other: hyperlaneBase,
  relayer: {
    ...hyperlaneBase,
    blacklist: [
      ...releaseCandidateHelloworldMatchingList,
      {
        originDomain: 137,
        recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
      },
    ],
    gasPaymentEnforcement,
  },
  validators: {
    ...hyperlaneBase,
    connectionType: AgentConnectionType.HttpQuorum,
    chains: validators,
  },
  scraper: {
    ...hyperlaneBase,
  },
};

const releaseCandidateBase = {
  ...base,
  context: Contexts.ReleaseCandidate,
  rolesWithKeys: [Role.Relayer, Role.Kathy],
};

const releaseCandidate: AgentConfig = {
  other: releaseCandidateBase,
  relayer: {
    ...releaseCandidateBase,
    whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrum.chainId],
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
