import {
  AgentSealevelHeliusFeeLevel,
  AgentSealevelPriorityFeeOracle,
  AgentSealevelPriorityFeeOracleType,
  AgentSealevelTransactionSubmitter,
  AgentSealevelTransactionSubmitterType,
  ChainName,
  GasPaymentEnforcement,
  GasPaymentEnforcementPolicyType,
  IsmCacheConfig,
  IsmCachePolicy,
  IsmCacheSelectorType,
  MatchingList,
  ModuleType,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import {
  AgentChainConfig,
  HELIUS_SECRET_URL_MARKER,
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config/agent/agent.js';
import {
  MetricAppContext,
  chainMapMatchingList,
  consistentSenderRecipientMatchingList,
  routerMatchingList,
  senderMatchingList,
  warpRouteMatchingList,
} from '../../../src/config/agent/relayer.js';
import { BaseScraperConfig } from '../../../src/config/agent/scraper.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts, mustBeValidContext } from '../../contexts.js';
import { getDomainId } from '../../registry.js';

import { environment, ethereumChainNames } from './chains.js';
import { blacklistedMessageIds } from './customBlacklist.js';
import { helloWorld } from './helloworld.js';
import aaveSenderAddresses from './misc-artifacts/aave-sender-addresses.json';
import everclearSenderAddresses from './misc-artifacts/everclear-sender-addresses.json';
import merklyEthAddresses from './misc-artifacts/merkly-eth-addresses.json';
import merklyNftAddresses from './misc-artifacts/merkly-eth-addresses.json';
import merklyErc20Addresses from './misc-artifacts/merkly-eth-addresses.json';
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
    abstract: true,
    // acala: true,
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    appchain: true,
    arbitrum: true,
    arbitrumnova: true,
    arcadia: true,
    artela: true,
    arthera: false,
    astar: true,
    aurora: true,
    avalanche: true,
    b3: true,
    base: true,
    berachain: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    botanix: true,
    bouncebit: true,
    bsc: true,
    bsquared: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    conflux: true,
    conwai: true,
    coredao: true,
    corn: true,
    coti: true,
    cyber: true,
    deepbrainchain: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    eclipsemainnet: true,
    endurance: true,
    ethereum: true,
    everclear: true,
    evmos: true,
    fantom: true,
    flame: true,
    flare: true,
    flowmainnet: true,
    fluence: true,
    form: true,
    // fractal: false,
    fraxtal: true,
    fusemainnet: true,
    game7: true,
    glue: true,
    gnosis: true,
    gravity: true,
    guru: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    inevm: true,
    infinityvmmainnet: true,
    injective: true,
    ink: true,
    kaia: true,
    katana: true,
    kroma: true,
    kyve: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    matchain: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    mint: true,
    miraclechain: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    nero: true,
    neutron: true,
    nibiru: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    paradex: true,
    peaq: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    reactive: true,
    real: true,
    redstone: true,
    rivalz: true,
    ronin: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    solanamainnet: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    starknet: true,
    story: true,
    stride: false,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    svmbnb: true,
    swell: true,
    taiko: true,
    tangle: true,
    telos: true,
    torus: true,
    treasure: true,
    trumpchain: true,
    unichain: true,
    unitzero: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    xpla: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zklink: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Relayer]: {
    abstract: true,
    // acala: true,
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    appchain: true,
    arcadia: true,
    arbitrum: true,
    arbitrumnova: true,
    artela: true,
    arthera: false,
    astar: true,
    aurora: true,
    avalanche: true,
    b3: true,
    base: true,
    berachain: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    botanix: true,
    bouncebit: true,
    bsc: true,
    bsquared: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    conflux: true,
    conwai: true,
    coredao: true,
    corn: true,
    coti: true,
    cyber: true,
    deepbrainchain: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    eclipsemainnet: true,
    endurance: true,
    ethereum: true,
    everclear: true,
    evmos: true,
    fantom: true,
    flame: true,
    flare: true,
    flowmainnet: true,
    fluence: true,
    form: true,
    // fractal: false,
    fraxtal: true,
    fusemainnet: true,
    game7: true,
    glue: true,
    gnosis: true,
    gravity: true,
    guru: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    inevm: true,
    infinityvmmainnet: true,
    injective: true,
    ink: true,
    kaia: true,
    katana: true,
    kroma: true,
    kyve: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    matchain: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    mint: true,
    miraclechain: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    nero: true,
    neutron: true,
    nibiru: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    paradex: true,
    peaq: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    reactive: true,
    real: true,
    redstone: true,
    rivalz: true,
    ronin: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    solanamainnet: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    starknet: true,
    story: true,
    stride: true,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    svmbnb: true,
    swell: true,
    taiko: true,
    tangle: true,
    telos: true,
    torus: true,
    treasure: true,
    trumpchain: true,
    unichain: true,
    unitzero: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    xpla: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zklink: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Scraper]: {
    abstract: true,
    // acala: true,
    ancient8: true,
    alephzeroevmmainnet: true,
    apechain: true,
    appchain: true,
    arbitrum: true,
    arbitrumnova: true,
    arcadia: true,
    artela: true,
    arthera: false,
    astar: true,
    aurora: true,
    avalanche: true,
    b3: true,
    base: true,
    berachain: true,
    bitlayer: true,
    blast: true,
    bob: true,
    boba: true,
    botanix: true,
    bouncebit: true,
    bsc: true,
    bsquared: true,
    celo: true,
    cheesechain: true,
    chilizmainnet: true,
    conflux: true,
    conwai: true,
    coredao: true,
    corn: true,
    coti: true,
    cyber: true,
    deepbrainchain: true,
    degenchain: true,
    dogechain: true,
    duckchain: true,
    eclipsemainnet: true,
    endurance: true,
    ethereum: true,
    everclear: true,
    evmos: true,
    fantom: true,
    flame: true,
    flare: true,
    flowmainnet: true,
    fluence: true,
    form: true,
    // fractal: false,
    fraxtal: true,
    fusemainnet: true,
    game7: true,
    glue: true,
    gnosis: true,
    gravity: true,
    guru: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    inevm: true,
    infinityvmmainnet: true,
    ink: true,
    injective: true,
    kaia: true,
    katana: true,
    kroma: true,
    kyve: true,
    linea: true,
    lisk: true,
    lukso: true,
    lumia: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    matchain: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    mint: true,
    miraclechain: true,
    mode: true,
    molten: true,
    moonbeam: true,
    morph: true,
    nero: true,
    neutron: true,
    nibiru: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    osmosis: true,
    paradex: true,
    peaq: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    proofofplay: true,
    rarichain: true,
    reactive: true,
    real: true,
    redstone: true,
    rivalz: true,
    ronin: true,
    rootstockmainnet: true,
    sanko: true,
    scroll: true,
    sei: true,
    shibarium: true,
    snaxchain: true,
    solanamainnet: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    starknet: true,
    story: true,
    stride: true,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    svmbnb: true,
    swell: true,
    taiko: true,
    tangle: true,
    telos: true,
    torus: true,
    treasure: true,
    trumpchain: true,
    unichain: true,
    unitzero: true,
    vana: true,
    // Has RPC non-compliance that breaks scraping.
    viction: false,
    worldchain: true,
    xai: true,
    xlayer: true,
    xpla: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zklink: true,
    zksync: true,
    zoramainnet: true,
  },
};

// Chains not in our core set of supported chains, and supported ONLY by the scraper
export const scraperOnlyChains: BaseScraperConfig['scraperOnlyChains'] = {
  forma: true,
  edgenchain: true,
};

export const hyperlaneContextAgentChainNames = getAgentChainNamesFromConfig(
  hyperlaneContextAgentChainConfig,
  mainnet3SupportedChainNames,
);

const sealevelPriorityFeeOracleConfigGetter = (
  chain: ChainName,
): AgentSealevelPriorityFeeOracle => {
  // Special case for Solana mainnet
  if (chain === 'solanamainnet') {
    return {
      type: AgentSealevelPriorityFeeOracleType.Helius,
      feeLevel: AgentSealevelHeliusFeeLevel.High,
      // URL is auto populated by the external secrets in the helm chart
      url: '',
    };
  } else if (chain === 'eclipsemainnet') {
    // As of Dec 23:
    // Eclipse has recently seen some increased usage with their referral program,
    // and we have had intermittent issues landing txs. Not many txs on Eclipse use
    // priority fees, so we use a low priority fee.
    return {
      type: AgentSealevelPriorityFeeOracleType.Constant,
      // 2000 micro lamports of ETH, which at a compute unit limit of 400K
      // and an ETH price of $3450 (Dec 23, 2024) comes to about $0.00276 USD:
      // >>> (((2000 / 1e6) * 400000) / 1e9) * 3450
      // 0.00276
      fee: '2000',
    };
  }

  // For all other chains, we use the constant fee oracle with a fee of 0
  return {
    type: AgentSealevelPriorityFeeOracleType.Constant,
    fee: '0',
  };
};

const sealevelTransactionSubmitterConfigGetter = (
  chain: ChainName,
): AgentSealevelTransactionSubmitter => {
  // Special case for Solana mainnet
  if (chain === 'solanamainnet') {
    return {
      type: AgentSealevelTransactionSubmitterType.Rpc,
      url: HELIUS_SECRET_URL_MARKER,
    };
  }

  // For all other chains, use the default RPC transaction submitter
  return {
    type: AgentSealevelTransactionSubmitterType.Rpc,
  };
};

const contextBase = {
  namespace: environment,
  runEnv: environment,
  environmentChainNames: supportedChainNames,
  aws: {
    region: 'us-east-1',
  },
  sealevel: {
    priorityFeeOracleConfigGetter: sealevelPriorityFeeOracleConfigGetter,
    transactionSubmitterConfigGetter: sealevelTransactionSubmitterConfigGetter,
  },
} as const;

const gasPaymentEnforcement: GasPaymentEnforcement[] = [
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: [
      // Infinity VM is gasless, so ignore outbound txs from InfinityVM to Solana.
      {
        originDomain: getDomainId('infinityvmmainnet'),
        destinationDomain: getDomainId('solanamainnet'),
      },
      { originDomain: getDomainId('starknet') },
      { originDomain: getDomainId('paradex') },
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.Minimum,
    payment: '1',
    matchingList: [
      // Temporary workaround due to funky Mantle gas amounts.
      { destinationDomain: getDomainId('mantle') },
      // Temporary workaround due to funky Torus gas amounts.
      { destinationDomain: getDomainId('torus') },
      // Infinity VM is gasless, so enforcing min 1 wei here ensures outbound txs
      // outside of Solana are ignored.
      { originDomain: getDomainId('infinityvmmainnet') },
      // Temporary workaround due to funky Zeronetwork gas amounts.
      { destinationDomain: getDomainId('zeronetwork') },
      // Temporary workaround during testing of MilkyWay.
      { originDomain: getDomainId('milkyway') },
      // Temporary workaround for some high gas amount estimates on Treasure
      ...warpRouteMatchingList(WarpRouteIds.ArbitrumTreasureMAGIC),
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
  },
];

// HYPER - https://github.com/hyperlane-xyz/hyperlane-registry-private/blob/6f9ef6ca2805480312b75894cf030acde37c5527/deployments/warp_routes/HYPER/arbitrum-base-bsc-ethereum-optimism-config.yaml
const hyperMatchingList = chainMapMatchingList({
  arbitrum: '0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4',
  base: '0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4',
  bsc: '0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4',
  ethereum: '0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5',
  optimism: '0x9923DB8d7FBAcC2E69E87fAd19b886C81cd74979',
});

// stHYPER - https://github.com/hyperlane-xyz/hyperlane-registry-private/blob/6f9ef6ca2805480312b75894cf030acde37c5527/deployments/warp_routes/stHYPER/bsc-ethereum-config.yaml#L1
const stHyperMatchingList = chainMapMatchingList({
  bsc: '0x6E9804a08092D8ba4E69DaCF422Df12459F2599E',
  ethereum: '0x9F6E6d150977dabc82d5D4EaaBDB1F1Ab0D25F92',
});

// Staging HYPER - https://github.com/hyperlane-xyz/hyperlane-registry-private/blob/38b91443b960a7887653445ef094c730bf708717/deployments/warp_routes/HYPER/arbitrum-base-bsc-ethereum-optimism-config.yaml
const stagingHyperMatchingList = chainMapMatchingList({
  arbitrum: '0xF80dcED2488Add147E60561F8137338F7f3976e1',
  base: '0x830B15a1986C75EaF8e048442a13715693CBD8bD',
  bsc: '0x9537c772c6092DB4B93cFBA93659bB5a8c0E133D',
  ethereum: '0xC10c27afcb915439C27cAe54F5F46Da48cd71190',
  optimism: '0x31cD131F5F6e1Cc0d6743F695Fc023B70D0aeAd8',
});

// Staging stHYPER - https://github.com/hyperlane-xyz/hyperlane-registry-private/blob/38b91443b960a7887653445ef094c730bf708717/deployments/warp_routes/stHYPER/bsc-ethereum-config.yaml
const stagingStHyperMatchingList = chainMapMatchingList({
  bsc: '0xf0c8c5fc69fCC3fA49C319Fdf422D8279756afE2',
  ethereum: '0x0C919509663cb273E156B706f065b9F7e6331891',
});

const vanguardMatchingList = [
  ...hyperMatchingList,
  ...stHyperMatchingList,
  ...stagingHyperMatchingList,
  ...stagingStHyperMatchingList,
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
      // Almost all messages to / from this address relate to the Velo Message Module.
      // The only exception is Metal, which had an initial misconfiguration that the Velo
      // team resolved with a different contract deploy. We can still only match on this address
      // as Metal is the only exception, so it's always receiving from or sending messages to this address.
      matchingList: consistentSenderRecipientMatchingList(
        '0xF385603a12Be8b7B885222329c581FDD1C30071D',
      ),
    },
    {
      name: 'velo_token_bridge',
      // All messages to / from this address relate to the Velo Token Bridge.
      matchingList: consistentSenderRecipientMatchingList(
        '0xA7287a56C01ac8Baaf8e7B662bDB41b10889C7A6',
      ),
    },
    {
      // https://github.com/bgd-labs/aave-delivery-infrastructure?tab=readme-ov-file#deployed-addresses
      // We match on senders because the sender is always the same and
      // well documented, while the recipient may be switched out and is
      // more poorly documented.
      name: 'aave',
      matchingList: senderMatchingList(aaveSenderAddresses),
    },
    {
      // https://docs.everclear.org/resources/contracts/mainnet
      // Messages between HubGateway (Everclear hub) <> EverclearSpoke (all other spoke chains)
      name: 'everclear_gateway',
      matchingList: senderMatchingList(everclearSenderAddresses),
    },
    // Manually specified for now until things are public
    {
      name: 'HYPER/arbitrum-base-bsc-ethereum-optimism',
      matchingList: hyperMatchingList,
    },
    {
      name: 'stHYPER/bsc-ethereum',
      matchingList: stHyperMatchingList,
    },
    {
      name: 'HYPER-STAGING/arbitrum-base-bsc-ethereum-optimism',
      matchingList: stagingHyperMatchingList,
    },
    {
      name: 'stHYPER-STAGING/bsc-ethereum',
      matchingList: stagingStHyperMatchingList,
    },
  ];
};

// Resource requests are based on observed usage found in https://abacusworks.grafana.net/d/FSR9YWr7k
const relayerResources = {
  requests: {
    cpu: '20000m',
    memory: '55G',
  },
};

const validatorResources = {
  requests: {
    cpu: '500m',
    memory: '1G',
  },
};

const scraperResources = {
  requests: {
    cpu: '2000m',
    memory: '4G',
  },
};

// Blacklist matching list intended to be used by all contexts.
const blacklist: MatchingList = [
  ...blacklistedMessageIds.map((messageId) => ({
    messageId,
  })),
];

const ismCacheConfigs: Array<IsmCacheConfig> = [
  {
    selector: {
      type: IsmCacheSelectorType.DefaultIsm,
    },
    moduleTypes: [
      ModuleType.AGGREGATION,
      ModuleType.MERKLE_ROOT_MULTISIG,
      ModuleType.MESSAGE_ID_MULTISIG,
      // The relayer will cache these per-origin to accommodate DomainRoutingIsms
      ModuleType.ROUTING,
    ],
    // SVM is explicitly not cached as the default ISM is a multisig ISM
    // that routes internally.
    chains: ethereumChainNames,
    cachePolicy: IsmCachePolicy.IsmSpecific,
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
      tag: 'cedc8e1-20250603-094703',
    },
    blacklist,
    gasPaymentEnforcement: gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: '3a58caa-20250604-135609',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    scraperOnlyChains,
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '3a58caa-20250604-135609',
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
      tag: '6e9f822-20250604-173142',
    },
    blacklist,
    // We're temporarily (ab)using the RC relayer as a way to increase
    // message throughput.
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: 'cedc8e1-20250603-094703',
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
      tag: 'cedc8e1-20250603-094703',
    },
    blacklist,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
};

const getVanguardRootAgentConfig = (index: number): RootAgentConfig => ({
  ...contextBase,
  context: mustBeValidContext(`vanguard${index}`),
  contextChainNames: {
    validator: [],
    relayer: ['bsc', 'arbitrum', 'optimism', 'ethereum', 'base'],
    scraper: [],
  },
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      // includes gasPriceCap overrides + per-chain maxSubmitQueueLength
      tag: '24fe342-20250424-164437',
    },
    whitelist: vanguardMatchingList,
    // Not specifying a blacklist for optimization purposes -- all the message IDs
    // in there are not vanguard-specific.
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: vanguardMatchingList,
      },
    ],
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
      // Cache for 10 minutes
      defaultExpirationSeconds: 10 * 60,
    },
    resources: {
      requests: {
        // Big enough to claim a c3-standard-44 each
        cpu: '35000m',
        memory: '100Gi',
      },
    },
    dbBootstrap: true,
    mixing: {
      enabled: true,
      // Arbitrary salt to ensure different agents have different sorting behavior for pending messages
      salt: 69690 + index,
    },
    batch: {
      defaultBatchSize: 32,
      batchSizeOverrides: {
        // Slightly lower to ideally fit within 5M
        ethereum: 26,
      },
      bypassBatchSimulation: true,
      maxSubmitQueueLength: {
        arbitrum: 350,
        base: 350,
        bsc: 350,
        optimism: 350,
        ethereum: 75,
      },
    },
    txIdIndexingEnabled: false,
    igpIndexingEnabled: false,
  },
});

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: neutron,
  [Contexts.Vanguard0]: getVanguardRootAgentConfig(0),
  [Contexts.Vanguard1]: getVanguardRootAgentConfig(1),
  [Contexts.Vanguard2]: getVanguardRootAgentConfig(2),
  [Contexts.Vanguard3]: getVanguardRootAgentConfig(3),
  [Contexts.Vanguard4]: getVanguardRootAgentConfig(4),
  [Contexts.Vanguard5]: getVanguardRootAgentConfig(5),
};
