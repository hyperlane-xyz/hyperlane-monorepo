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
  MetricAppContext,
  routerMatchingList,
  senderMatchingList,
  warpRouteMatchingList,
} from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getDomainId } from '../../registry.js';

import { environment } from './chains.js';
import { helloWorld } from './helloworld.js';
import aaveSenderAddresses from './misc-artifacts/aave-sender-addresses.json';
import merklyEthAddresses from './misc-artifacts/merkly-eth-addresses.json';
import merklyNftAddresses from './misc-artifacts/merkly-eth-addresses.json';
import merklyErc20Addresses from './misc-artifacts/merkly-eth-addresses.json';
import veloMessageModuleAddresses from './misc-artifacts/velo-message-module-addresses.json';
import veloTokenBridgeAddresses from './misc-artifacts/velo-token-bridge-addresses.json';
import {
  mainnet3SupportedChainNames,
  supportedChainNames,
} from './supportedChainNames.js';
import { validatorChainConfig } from './validators.js';
import { WarpRouteIds } from './warp/warpIds.js';

// const releaseCandidateHelloworldMatchingList = routerMatchingList(
//   helloWorld[Contexts.ReleaseCandidate].addresses,
// );

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked / enforced at runtime & in the CI pipeline.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig<
  typeof mainnet3SupportedChainNames
> = {
  // Generally, we run all production validators in the Hyperlane context.
  [Role.Validator]: {
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    arbitrum: true,
    arbitrumnova: true,
    astar: true,
    astarzkevm: true,
    flame: true,
    avalanche: true,
    b3: true,
    base: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    bsc: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    coredao: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    eclipsemainnet: true,
    endurance: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: true,
    fraxtal: true,
    fusemainnet: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    immutablezkevmmainnet: true,
    inevm: true,
    injective: true,
    kaia: true,
    kroma: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    mantapacific: true,
    mantle: true,
    merlin: true,
    metal: true,
    metis: true,
    mint: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    neutron: true,
    oortmainnet: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    real: true,
    redstone: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    solanamainnet: true,
    stride: false,
    superseed: true,
    superpositionmainnet: true,
    taiko: true,
    tangle: true,
    unichain: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Relayer]: {
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    arbitrum: true,
    arbitrumnova: true,
    astar: true,
    astarzkevm: true,
    flame: true,
    avalanche: true,
    b3: true,
    base: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    bsc: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    coredao: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    eclipsemainnet: true,
    endurance: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: true,
    fraxtal: true,
    fusemainnet: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    immutablezkevmmainnet: true,
    inevm: true,
    injective: true,
    kaia: true,
    kroma: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    mantapacific: true,
    mantle: true,
    merlin: true,
    metal: true,
    metis: true,
    mint: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    // At the moment, we only relay between Neutron and Manta Pacific on the neutron context.
    neutron: false,
    oortmainnet: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    real: true,
    redstone: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    solanamainnet: true,
    stride: true,
    superseed: true,
    superpositionmainnet: true,
    taiko: true,
    tangle: true,
    unichain: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Scraper]: {
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    arbitrum: true,
    arbitrumnova: true,
    astar: true,
    astarzkevm: true,
    flame: true,
    avalanche: true,
    b3: true,
    base: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    bsc: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    coredao: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    // Cannot scrape Sealevel chains
    eclipsemainnet: false,
    endurance: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: true,
    fraxtal: true,
    fusemainnet: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    immutablezkevmmainnet: true,
    inevm: true,
    injective: true,
    kaia: true,
    kroma: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    mantapacific: true,
    mantle: true,
    merlin: true,
    metal: true,
    metis: true,
    mint: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    neutron: true,
    oortmainnet: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    real: true,
    redstone: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    // Cannot scrape Sealevel chains
    solanamainnet: false,
    stride: true,
    superseed: true,
    superpositionmainnet: true,
    taiko: true,
    tangle: true,
    unichain: true,
    vana: true,
    // Has RPC non-compliance that breaks scraping.
    viction: false,
    worldchain: true,
    xai: true,
    xlayer: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
};

export const hyperlaneContextAgentChainNames = getAgentChainNamesFromConfig(
  hyperlaneContextAgentChainConfig,
  mainnet3SupportedChainNames,
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
    type: GasPaymentEnforcementPolicyType.Minimum,
    payment: '1',
    matchingList: [
      // Temporary workaround due to funky Mantle gas amounts.
      { destinationDomain: getDomainId('mantle') },
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

// Gets metric app contexts, including:
// - helloworld
// - all warp routes defined in WarpRouteIds, using addresses from the registry
// - misc important applications not defined in the registry, e.g. merkly
const metricAppContextsGetter = (): MetricAppContext[] => {
  const warpContexts = Object.values(WarpRouteIds).map((warpRouteId) => {
    return {
      name: warpRouteId,
      matchingList: warpRouteMatchingList(warpRouteId),
    };
  });

  return [
    ...warpContexts,
    {
      name: 'helloworld',
      matchingList: routerMatchingList(
        helloWorld[Contexts.Hyperlane].addresses,
      ),
    },
    {
      name: 'merkly_erc20',
      matchingList: routerMatchingList(merklyErc20Addresses),
    },
    {
      name: 'merkly_eth',
      matchingList: routerMatchingList(merklyEthAddresses),
    },
    {
      name: 'merkly_nft',
      matchingList: routerMatchingList(merklyNftAddresses),
    },
    {
      name: 'velo_message_module',
      matchingList: routerMatchingList(veloMessageModuleAddresses),
    },
    {
      name: 'velo_token_bridge',
      matchingList: routerMatchingList(veloTokenBridgeAddresses),
    },
    {
      // https://github.com/bgd-labs/aave-delivery-infrastructure?tab=readme-ov-file#deployed-addresses
      // We match on senders because the sender is always the same and
      // well documented, while the recipient may be switched out and is
      // more poorly documented.
      name: 'aave',
      matchingList: senderMatchingList(aaveSenderAddresses),
    },
  ];
};

// Resource requests are based on observed usage found in https://abacusworks.grafana.net/d/FSR9YWr7k
const relayerResources = {
  requests: {
    cpu: '14000m',
    memory: '12Gi',
  },
};

const validatorResources = {
  requests: {
    cpu: '500m',
    memory: '1Gi',
  },
};

const scraperResources = {
  requests: {
    cpu: '2000m',
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
      tag: 'e70431a-20241121-160243',
    },
    gasPaymentEnforcement: gasPaymentEnforcement,
    metricAppContextsGetter,
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: 'e70431a-20241121-160243',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'e70431a-20241121-160243',
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
      tag: '25a927d-20241114-171323',
    },
    // We're temporarily (ab)using the RC relayer as a way to increase
    // message throughput.
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: 'a64af8b-20241024-120818',
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
      tag: '25a927d-20241114-171323',
    },
    gasPaymentEnforcement,
    metricAppContextsGetter,
    resources: relayerResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: neutron,
};
