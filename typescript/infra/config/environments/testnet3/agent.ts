import { AgentConnectionType, chainMetadata } from '@hyperlane-xyz/sdk';

import {
  GasPaymentEnforcementPolicyType,
  RootAgentConfig,
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

const contextBase = {
  namespace: environment,
  runEnv: environment,
  contextChainNames: chainNames,
  environmentChainNames: chainNames,
  aws: {
    region: 'us-east-1',
  },
} as const;

const roleBase = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: '2deb9b8-20230602-205342',
  },
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
  // Default policy is OnChainFeeQuoting
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

const hyperlane: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    ...roleBase,
    blacklist: [
      // ...releaseCandidateHelloworldMatchingList,
      // {
      //   // In an effort to reduce some giant retry queues that resulted
      //   // from spam txs to the old TestRecipient before we were charging for
      //   // gas, we blacklist the old TestRecipient address.
      //   recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
      // },
      {
        senderAddress: '*',
      },
    ],
    gasPaymentEnforcement,
  },
  validators: {
    ...roleBase,
    chains: validators,
  },
  scraper: {
    ...roleBase,
  },
};

const releaseCandidate: RootAgentConfig = {
  ...contextBase,
  context: Contexts.ReleaseCandidate,
  rolesWithKeys: [Role.Relayer, Role.Kathy],
  relayer: {
    ...roleBase,
    whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrumgoerli.chainId],
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
