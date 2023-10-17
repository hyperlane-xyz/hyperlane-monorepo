import {
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
  chainMetadata,
  getDomainId,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter, objMap } from '@hyperlane-xyz/utils';

import {
  RootAgentConfig,
  allAgentChainNames,
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

const interchainQueryRouters = objFilter(
  objMap(hyperlaneEnvironments.mainnet, (_, addresses) => {
    return {
      router: addresses.interchainQueryRouter,
    };
  }),
  (chain, _addresses): _addresses is { router: string } =>
    chainMetadata[chain].protocol === ProtocolType.Ethereum,
);

const interchainQueriesMatchingList = routerMatchingList(
  interchainQueryRouters,
);

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

const bscNautilusWarpRoutes: Array<{ router: string }> = [
  // ZBC
  {
    router: '0xC27980812E2E66491FD457D488509b7E04144b98',
  },
  // ETH
  {
    router: '0x2a6822dc5639b3fe70de6b65b9ff872e554162fa',
  },
  // USDC
  {
    router: '0x6937a62f93a56D2AE9392Fa1649b830ca37F3ea4',
  },
  // BTC
  {
    router: '0xB3545006A532E8C23ebC4e33d5ab2232Cafc35Ad',
  },
  // USDT
  {
    router: '0xb7d36720a16A1F9Cfc1f7910Ac49f03965401a36',
  },
  // POSE
  {
    router: '0x97a2D58d30A2c838946194494207F7Cf50c25815',
  },
];

const gasPaymentEnforcement: GasPaymentEnforcementConfig[] = [
  {
    type: GasPaymentEnforcementPolicyType.None,
    // To continue relaying interchain query callbacks, we whitelist
    // all messages between interchain query routers.
    // This whitelist will become more strict with
    // https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/1605
    matchingList: [
      ...interchainQueriesMatchingList,
      {
        originDomain: [getDomainId(chainMetadata.bsc)],
        senderAddress: bscNautilusWarpRoutes.map((r) => r.router),
        destinationDomain: '*',
        recipientAddress: '*',
      },
      // Temporarily don't charge gas for the Solana -> Nautilus ZBC warp route,
      // as IGP indexing in the agents is currently incompatible with the deployed IGP.
      {
        originDomain: [getDomainId(chainMetadata.solana)],
        senderAddress: ['EJqwFjvVJSAxH8Ur2PYuMfdvoJeutjmH6GkoEFQ4MdSa'],
        destinationDomain: [getDomainId(chainMetadata.nautilus)],
        recipientAddress: '*',
      },
      // Similarly, temporarily not charging gas for Helloworld from Solana
      {
        originDomain: [getDomainId(chainMetadata.solana)],
        senderAddress: [
          // Hyperlane context
          '4k1gruSdH1r57V9QQK4aunzfMYzLFfF83jdYkkEwyem6',
          // Rc context
          '3pPDp16iVTJFge2sm85Q61hW61UN5xNqeG24gqFhzLFV',
        ],
        destinationDomain: '*',
        recipientAddress: '*',
      },
    ],
  },
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
      tag: '35fdc74-20230913-104940',
    },
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
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    chainDockerOverrides: {
      [chainMetadata.solana.name]: {
        tag: '3b0685f-20230815-110725',
      },
      [chainMetadata.nautilus.name]: {
        tag: '3b0685f-20230815-110725',
      },
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
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
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '35fdc74-20230913-104940',
    },
    whitelist: releaseCandidateHelloworldMatchingList,
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
