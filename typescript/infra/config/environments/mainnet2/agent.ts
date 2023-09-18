import {
  AgentConnectionType,
  ChainMap,
  chainMetadata,
  getDomainId,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import {
  GasPaymentEnforcementPolicyType,
  RootAgentConfig,
  allAgentChainNames,
  routerMatchingList,
} from '../../../src/config';
import {
  GasPaymentEnforcementConfig,
  MatchingList,
} from '../../../src/config/agent/relayer';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { agentChainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import { validatorChainConfig } from './validators';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const interchainQueryRouters = objMap(
  hyperlaneEnvironments.mainnet,
  (_, addresses) => {
    return {
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
  environmentChainNames: allAgentChainNames(agentChainNames),
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
    matchingList: [
      ...interchainQueriesMatchingList,
      {
        originDomain: [getDomainId(chainMetadata.solana)],
        senderAddress: '*',
        destinationDomain: '*',
        recipientAddress: '*',
      },
      {
        originDomain: [getDomainId(chainMetadata.bsc)],
        senderAddress: ['0xC27980812E2E66491FD457D488509b7E04144b98'],
        destinationDomain: '*',
        recipientAddress: '*',
      },
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
    matchingList: [
      {
        originDomain: [getDomainId(chainMetadata.solana)],
        // solana -> nautilus warp route
        senderAddress: ['EJqwFjvVJSAxH8Ur2PYuMfdvoJeutjmH6GkoEFQ4MdSa'],
        destinationDomain: '*',
        recipientAddress: '*',
      },
    ],
  },
];

const nautilusWarpRoutes: Array<ChainMap<{ router: string }>> = [
  {
    bsc: {
      router: '0xC27980812E2E66491FD457D488509b7E04144b98',
    },
    nautilus: {
      router: '0x4501bBE6e731A4bC5c60C03A77435b2f6d5e9Fe7',
    },
    solana: {
      router:
        '0xc5ba229fa2822fe65ac2bd0a93d8371d75292c3415dd381923c1088a3308528b',
    },
  },
  // ETH
  {
    bsc: {
      router: '0x2a6822dc5639b3fe70de6b65b9ff872e554162fa',
    },
    nautilus: {
      router: '0x182E8d7c5F1B06201b102123FC7dF0EaeB445a7B',
    },
  },
  // USDC
  {
    bsc: {
      router: '0x6937a62f93a56D2AE9392Fa1649b830ca37F3ea4',
    },
    nautilus: {
      router: '0xB2723928400AE5778f6A3C69D7Ca9e90FC430180',
    },
  },
  // BTC
  {
    bsc: {
      router: '0xB3545006A532E8C23ebC4e33d5ab2232Cafc35Ad',
    },
    nautilus: {
      router: '0x61DDB465eEA5bc3708Cf8B53156aC91a77A2f029',
    },
  },
  // USDT
  {
    bsc: {
      router: '0xb7d36720a16A1F9Cfc1f7910Ac49f03965401a36',
    },
    nautilus: {
      router: '0xBDa330Ea8F3005C421C8088e638fBB64fA71b9e0',
    },
  },
  // POSE
  {
    bsc: {
      router: '0x807D2C6c3d64873Cc729dfC65fB717C3E05e682f',
    },
    nautilus: {
      router: '0xA1ac41d8A663fd317cc3BD94C7de92dC4BA4a882',
    },
  },
];

const nautilusWarpRouteMatchingList = nautilusWarpRoutes.reduce(
  (agg, warpRoute) => [...agg, ...routerMatchingList(warpRoute)],
  [] as MatchingList,
);

const hyperlane: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    connectionType: AgentConnectionType.HttpFallback,
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
    gasPaymentEnforcement: [
      // Don't require gas payments for ZBC bridging.
      // In practice, gas payments are forced to still occur due to on-chain fee quoting.
      // We need this because the IGP that's paid on BSC isn't the "canonical" one (it's from a PI deployment),
      // and because the Solana warp route does not yet have an IGP configured.
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: nautilusWarpRouteMatchingList,
      },
      ...gasPaymentEnforcement,
    ],
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
    connectionType: AgentConnectionType.HttpQuorum,
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
      tag: '3b0685f-20230815-110725',
    },
    whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrum.chainId],
  },
  validators: {
    docker: {
      repo,
      tag: 'ed7569d-20230725-171222',
    },
    connectionType: AgentConnectionType.HttpQuorum,
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
