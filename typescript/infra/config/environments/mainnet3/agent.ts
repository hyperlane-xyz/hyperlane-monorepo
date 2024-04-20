import {
  GasPaymentEnforcement,
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import {
  AgentChainConfig,
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config/agent/agent.js';
import {
  matchingList,
  routerMatchingList,
} from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getDomainId } from '../../registry.js';

import { environment, supportedChainNames } from './chains.js';
import { helloWorld } from './helloworld.js';
import { validatorChainConfig } from './validators.js';
import ancient8EthereumUsdcAddresses from './warp/ancient8-USDC-addresses.json';
import arbitrumTIAAddresses from './warp/arbitrum-TIA-addresses.json';
import inevmEthereumUsdcAddresses from './warp/inevm-USDC-addresses.json';
import inevmEthereumUsdtAddresses from './warp/inevm-USDT-addresses.json';
import injectiveInevmInjAddresses from './warp/injective-inevm-addresses.json';
import mantaTIAAddresses from './warp/manta-TIA-addresses.json';
import victionEthereumEthAddresses from './warp/viction-ETH-addresses.json';
import victionEthereumUsdcAddresses from './warp/viction-USDC-addresses.json';
import victionEthereumUsdtAddresses from './warp/viction-USDT-addresses.json';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked / enforced at runtime & in the CI pipeline.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig = {
  // Generally, we run all production validators in the Hyperlane context.
  [Role.Validator]: {
    arbitrum: true,
    ancient8: true,
    avalanche: true,
    bsc: true,
    celo: true,
    ethereum: true,
    neutron: true,
    mantapacific: true,
    moonbeam: true,
    optimism: true,
    polygon: true,
    gnosis: true,
    base: true,
    scroll: true,
    polygonzkevm: true,
    injective: true,
    inevm: true,
    viction: true,
  },
  [Role.Relayer]: {
    arbitrum: true,
    ancient8: true,
    avalanche: true,
    bsc: true,
    celo: true,
    ethereum: true,
    // At the moment, we only relay between Neutron and Manta Pacific on the neutron context.
    neutron: false,
    mantapacific: false,
    moonbeam: true,
    optimism: true,
    polygon: true,
    gnosis: true,
    base: true,
    scroll: true,
    polygonzkevm: true,
    injective: true,
    inevm: true,
    viction: true,
  },
  [Role.Scraper]: {
    arbitrum: true,
    ancient8: false,
    avalanche: true,
    bsc: true,
    celo: true,
    ethereum: true,
    // Cannot scrape non-EVM chains
    neutron: false,
    mantapacific: true,
    moonbeam: true,
    optimism: true,
    polygon: true,
    gnosis: true,
    base: true,
    scroll: true,
    polygonzkevm: true,
    // Cannot scrape non-EVM chains
    injective: false,
    inevm: true,
    // Has RPC non-compliance that breaks scraping.
    viction: false,
  },
};

export const hyperlaneContextAgentChainNames = getAgentChainNamesFromConfig(
  hyperlaneContextAgentChainConfig,
  supportedChainNames,
);

const contextBase = {
  namespace: environment,
  runEnv: environment,
  environmentChainNames: supportedChainNames,
  aws: {
    region: 'us-east-1',
  },
} as const;

const gasPaymentEnforcement: GasPaymentEnforcement[] = [
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

const hyperlane: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Hyperlane,
  contextChainNames: hyperlaneContextAgentChainNames,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '2a16200-20240408-214947',
    },
    gasPaymentEnforcement: [
      // Temporary measure to ensure all inEVM warp route messages are delivered -
      // we saw some issues with IGP indexing.
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: routerMatchingList(injectiveInevmInjAddresses),
      },
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: matchingList(inevmEthereumUsdcAddresses),
      },
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: matchingList(inevmEthereumUsdtAddresses),
      },
      ...gasPaymentEnforcement,
    ],
    metricAppContexts: [
      {
        name: 'helloworld',
        matchingList: routerMatchingList(
          helloWorld[Contexts.Hyperlane].addresses,
        ),
      },
      {
        name: 'injective_inevm_inj',
        matchingList: routerMatchingList(injectiveInevmInjAddresses),
      },
      {
        name: 'inevm_ethereum_usdc',
        matchingList: matchingList(inevmEthereumUsdcAddresses),
      },
      {
        name: 'inevm_ethereum_usdt',
        matchingList: matchingList(inevmEthereumUsdtAddresses),
      },
      {
        name: 'viction_ethereum_eth',
        matchingList: routerMatchingList(victionEthereumEthAddresses),
      },
      {
        name: 'viction_ethereum_usdc',
        matchingList: routerMatchingList(victionEthereumUsdcAddresses),
      },
      {
        name: 'viction_ethereum_usdt',
        matchingList: routerMatchingList(victionEthereumUsdtAddresses),
      },
      {
        name: 'ancient8_ethereum_usdc',
        matchingList: routerMatchingList(ancient8EthereumUsdcAddresses),
      },
    ],
  },
  validators: {
    docker: {
      repo,
      tag: 'c1da894-20240321-175000',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'ae0990a-20240313-215426',
    },
  },
};

const releaseCandidate: RootAgentConfig = {
  ...contextBase,
  context: Contexts.ReleaseCandidate,
  contextChainNames: hyperlaneContextAgentChainNames,
  rolesWithKeys: [Role.Relayer, Role.Kathy, Role.Validator],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'a72c3cf-20240314-173418',
    },
    whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: ['arbitrum'],
  },
  validators: {
    docker: {
      repo,
      tag: 'ae0990a-20240313-215426',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

const neutron: RootAgentConfig = {
  ...contextBase,
  contextChainNames: {
    validator: [],
    relayer: ['neutron', 'mantapacific', 'arbitrum'],
    scraper: [],
  },
  context: Contexts.Neutron,
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'a72c3cf-20240314-173418',
    },
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: [
          {
            originDomain: getDomainId('neutron'),
            destinationDomain: getDomainId('mantapacific'),
            senderAddress: '*',
            recipientAddress: '*',
          },
          {
            originDomain: getDomainId('neutron'),
            destinationDomain: getDomainId('arbitrum'),
            senderAddress: '*',
            recipientAddress: '*',
          },
        ],
      },
      ...gasPaymentEnforcement,
    ],
    metricAppContexts: [
      {
        name: 'manta_tia',
        matchingList: routerMatchingList(mantaTIAAddresses),
      },
      {
        name: 'arbitrum_tia',
        matchingList: routerMatchingList(arbitrumTIAAddresses),
      },
    ],
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: neutron,
};
