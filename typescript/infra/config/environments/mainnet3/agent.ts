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

import { environment } from './chains.js';
import { helloWorld } from './helloworld.js';
import { supportedChainNames } from './supportedChainNames.js';
import { validatorChainConfig } from './validators.js';
import ancient8EthereumUsdcAddresses from './warp/ancient8-USDC-addresses.json';
import arbitrumTIAAddresses from './warp/arbitrum-TIA-addresses.json';
import arbitrumNeutronEclipAddresses from './warp/arbitrum-neutron-eclip-addresses.json';
import inevmEthereumUsdcAddresses from './warp/inevm-USDC-addresses.json';
import inevmEthereumUsdtAddresses from './warp/inevm-USDT-addresses.json';
import injectiveInevmInjAddresses from './warp/injective-inevm-addresses.json';
import mantaTIAAddresses from './warp/manta-TIA-addresses.json';
import renzoEzEthAddresses from './warp/renzo-ezETH-addresses.json';
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
    base: true,
    blast: true,
    bob: false,
    bsc: true,
    celo: true,
    ethereum: true,
    fraxtal: true,
    gnosis: true,
    injective: true,
    inevm: true,
    linea: true,
    mantapacific: true,
    mantle: false,
    mode: true,
    moonbeam: true,
    neutron: true,
    optimism: true,
    osmosis: true,
    polygon: true,
    polygonzkevm: true,
    redstone: true,
    scroll: true,
    sei: true,
    taiko: false,
    viction: true,
    zetachain: true,
  },
  [Role.Relayer]: {
    arbitrum: true,
    ancient8: true,
    avalanche: true,
    base: true,
    blast: true,
    bob: false,
    bsc: true,
    celo: true,
    ethereum: true,
    fraxtal: true,
    gnosis: true,
    injective: true,
    inevm: true,
    linea: true,
    mantapacific: true,
    mantle: false,
    mode: true,
    moonbeam: true,
    // At the moment, we only relay between Neutron and Manta Pacific on the neutron context.
    neutron: false,
    optimism: true,
    osmosis: true,
    polygon: true,
    polygonzkevm: true,
    redstone: true,
    scroll: true,
    sei: true,
    taiko: false,
    viction: true,
    zetachain: true,
  },
  [Role.Scraper]: {
    arbitrum: true,
    ancient8: true,
    avalanche: true,
    base: true,
    blast: true,
    bob: false,
    bsc: true,
    celo: true,
    ethereum: true,
    fraxtal: true,
    gnosis: true,
    // Cannot scrape non-EVM chains
    injective: false,
    inevm: true,
    linea: true,
    mantapacific: true,
    mantle: false,
    mode: true,
    moonbeam: true,
    // Cannot scrape non-EVM chains
    neutron: false,
    optimism: true,
    // Cannot scrape non-EVM chains
    osmosis: false,
    polygon: true,
    polygonzkevm: true,
    redstone: true,
    // Out of caution around pointer contracts (https://www.docs.sei.io/dev-interoperability/pointer-contracts) not being compatible
    // and the scraper not gracefully handling txs that may not exist via the eth RPC, we don't run the scraper.
    sei: false,
    scroll: true,
    taiko: false,
    // Has RPC non-compliance that breaks scraping.
    viction: false,
    zetachain: true,
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
  // To cover ourselves against IGP indexing issues and to ensure Nexus
  // users have the best possible experience, we whitelist messages between
  // warp routes that we know are certainly paying for gas.
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: [
      ...routerMatchingList(injectiveInevmInjAddresses),
      ...matchingList(inevmEthereumUsdcAddresses),
      ...matchingList(inevmEthereumUsdtAddresses),
      ...routerMatchingList(victionEthereumEthAddresses),
      ...routerMatchingList(victionEthereumUsdcAddresses),
      ...routerMatchingList(victionEthereumUsdtAddresses),
      ...routerMatchingList(ancient8EthereumUsdcAddresses),
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: matchingList(inevmEthereumUsdcAddresses),
  },
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: matchingList(inevmEthereumUsdtAddresses),
  },
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

const metricAppContexts = [
  {
    name: 'helloworld',
    matchingList: routerMatchingList(helloWorld[Contexts.Hyperlane].addresses),
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
  {
    name: 'renzo_ezeth',
    matchingList: routerMatchingList(renzoEzEthAddresses),
  },
];

// Resource requests are based on observed usage found in https://abacusworks.grafana.net/d/FSR9YWr7k
const relayerResources = {
  requests: {
    cpu: '14000m',
    memory: '12Gi',
  },
};

const validatorResources = {
  requests: {
    cpu: '250m',
    memory: '256Mi',
  },
};

const scraperResources = {
  requests: {
    cpu: '100m',
    memory: '4Gi',
  },
};

const hyperlane: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Hyperlane,
  contextChainNames: hyperlaneContextAgentChainNames,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '9535087-20240623-174819',
    },
    gasPaymentEnforcement: gasPaymentEnforcement,
    metricAppContexts,
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: '0d12ff3-20240620-173353',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '0d12ff3-20240620-173353',
    },
    resources: scraperResources,
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
      tag: '9535087-20240623-174819',
    },
    // We're temporarily (ab)using the RC relayer as a way to increase
    // message throughput.
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    metricAppContexts,
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: '0d12ff3-20240620-173353',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
    resources: validatorResources,
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
      tag: '0d12ff3-20240620-173353',
    },
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: [
          ...routerMatchingList(mantaTIAAddresses),
          ...routerMatchingList(arbitrumTIAAddresses),
          ...routerMatchingList(arbitrumNeutronEclipAddresses),
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
      {
        name: 'arbitrum_neutron_eclip',
        matchingList: routerMatchingList(arbitrumNeutronEclipAddresses),
      },
    ],
    resources: relayerResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: neutron,
};
