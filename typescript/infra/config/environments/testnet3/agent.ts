import {
  AgentConnectionType,
  chainMetadata,
  getDomainId,
  hyperlaneEnvironments,
  objMap,
} from '@hyperlane-xyz/sdk';

import {
  GasPaymentEnforcementPolicyType,
  RootAgentConfig,
  routerMatchingList,
} from '../../../src/config';
import { GasPaymentEnforcementConfig } from '../../../src/config/agent/relayer';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { agentChainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import { validatorChainConfig } from './validators';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const interchainQueryRouters = objMap(
  hyperlaneEnvironments.testnet,
  (_, addresses) => {
    return {
      // @ts-ignore moonbasealpha has no interchain query router
      router: addresses.interchainQueryRouter,
    };
  },
);

const interchainQueriesMatchingList = routerMatchingList(
  interchainQueryRouters,
);

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

const contextBase = {
  namespace: environment,
  runEnv: environment,
  contextChainNames: agentChainNames,
  environmentChainNames: agentChainNames,
  aws: {
    region: 'us-east-1',
  },
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
    connectionType: AgentConnectionType.HttpFallback,
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    blacklist: [
      ...releaseCandidateHelloworldMatchingList,
      {
        // In an effort to reduce some giant retry queues that resulted
        // from spam txs to the old TestRecipient before we were charging for
        // gas, we blacklist the old TestRecipient address.
        recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
      },
    ],
    gasPaymentEnforcement,
  },
  validators: {
    connectionType: AgentConnectionType.HttpFallback,
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    chainDockerOverrides: {
      [chainMetadata.solanadevnet.name]: {
        tag: '79bad9d-20230706-190752',
      },
      [chainMetadata.zbctestnet.name]: {
        tag: '79bad9d-20230706-190752',
      },
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    connectionType: AgentConnectionType.HttpFallback,
    docker: {
      repo,
      tag: 'aaddba7-20230620-154941',
    },
  },
};

const releaseCandidate: RootAgentConfig = {
  ...contextBase,
  context: Contexts.ReleaseCandidate,
  rolesWithKeys: [Role.Relayer, Role.Kathy, Role.Validator],
  relayer: {
    connectionType: AgentConnectionType.HttpFallback,
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    whitelist: [
      ...releaseCandidateHelloworldMatchingList,
      // Whitelist all traffic to solanadevnet and zbctestnet
      {
        originDomain: '*',
        senderAddress: '*',
        destinationDomain: [
          getDomainId(chainMetadata.solanadevnet),
          getDomainId(chainMetadata.zbctestnet),
        ],
        recipientAddress: '*',
      },
      // Whitelist all traffic from solanadevnet and zbctestnet to fuji
      {
        originDomain: [
          getDomainId(chainMetadata.solanadevnet),
          getDomainId(chainMetadata.zbctestnet),
        ],
        senderAddress: '*',
        destinationDomain: [getDomainId(chainMetadata.fuji)],
        recipientAddress: '*',
      },
    ],
    gasPaymentEnforcement: [
      // Don't require gas payments from solanadevnet or zbctestnet
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: [
          {
            originDomain: [
              getDomainId(chainMetadata.solanadevnet),
              getDomainId(chainMetadata.zbctestnet),
            ],
            senderAddress: '*',
            destinationDomain: [getDomainId(chainMetadata.fuji)],
            recipientAddress: '*',
          },
        ],
      },
      ...gasPaymentEnforcement,
    ],
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrumgoerli.chainId],
  },
  validators: {
    connectionType: AgentConnectionType.HttpFallback,
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
