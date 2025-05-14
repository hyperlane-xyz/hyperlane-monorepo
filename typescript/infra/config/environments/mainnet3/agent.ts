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
    arthera: true,
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
    arthera: true,
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
    arthera: true,
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

const blacklistedMessageIds = [
  // ezETH
  '0xb9cfeb4a22b65903ca7cb514fd752feba0622a0495878d508d19a91734d89cc4',
  '0x13d6c56781ee9b8811f4e17198bf064baed2682ce44193c750e76c73384466e7',
  '0x366520dcd48f19a2cdc806e244d4cea970a587e3932320baee30e710d316b303',
  '0x0f9b8849d6dbf5a699e906a6e06044d6cf84ee0ba2174cec28db4fceba52616a',
  '0x0e1235105208e7d3a616ac2bb780e7dab30fc289670ba8d6655a4ded73f9b5da',
  '0xa6fdecc3f21d081bf3d78da9ddf516b24397a6bff44d7cd4614955f5ca2320b2',
  '0x2c3484724a97524fd95aa8aec34a0ae30f79e14e1b228cce9dc1793cea40fc3d',
  '0x11ffaeaae5c431501584bc39805ef44b4080e7f90ca7ff609a131d58d1f75ae6',
  '0xc18ea74675bc1e5b780e63ac6063c7c39189e1848b8fe52ac40b83fff9268483',
  '0xd8040094ab94e44e2b3b57ab0704a33e363f46261a45c9dfc788371c808b8f3a',
  '0xf7f0be22f46144793ee3fadccddd4cfb8422d36f5d59bb86fea3782b89160d49',
  '0xeda79ab37b4a05d8f318b3a465a70572d819b2c37456c48835a30bb6c016e194',
  '0xaf7c7dfc4d19aec283c619a2724d03fbbfeef4a468e84c0573551c1adca40ded',
  '0x4a2c42c283755400c0dc7f1be65f6ff026a38aacaa6505302d465268bcd86b21',
  '0x0f80e5b8da5a706d6273a622a5c29f83cee5f37e6376c2c8a615b0ef91a540df',
  '0x6359232ef1f239d9519104cf47f1e2fbcbe25f8ee68001c5eff7e81bf23b396c',
  '0x6a3fb736b952467b814e93fb35edf3a824d35efd1e4b10e3ed465595c55af88a',

  // pzETH
  '0x14cb552c08de9f131b750c2f821f90e5ff685e1d3d714e912f7603b2f4b7adb4',
  '0xaa5b5021200e66b4a47e5156106c46b6b2bc1e00b088a524a14bb0709cbf733e',
  '0x43b4cf52255a7728a3c409f76fd20ba0c36cb42854e0b0a0eefdde848363224b',
  '0x047f34405014b117dccd6d8981c846dc3fe746f5e758f90f227581c735f4f11a',
  '0x47d60c21abefae928d1c16c5a33cd5a8fcf870cf533c71ab6db49d75a5c4a215',
  '0xa2df671fbd4b518c282f9a21e2677fa2a05af33f96ccc9ff113f1a1ffa557667',
  '0x1cefa98b6d937333e452a0dbc0654e13416c228682837a8913cb18d612b307dd',

  // MAGIC/ethereum-treasure native funding txs
  '0x9d51f4123be816cbaeef2e2b34a5760f633a7cb8a019fe16f88a3227cc22451e',
  '0x663c221137028ceeeb102a98e48b362a7b48d626b93c88c7fdf1871a948b1223',
  '0xbcc3e52dbc909f75425f4bdd83c94a31d8e3bc816422396dbe1f796ff8a5aadd',

  // txs between unenrolled routers of
  // ETH/arbitrum-base-blast-bsc-ethereum-gnosis-lisk-mantle-mode-optimism-polygon-scroll-zeronetwork-zoramainnet
  '0x229a832dfdfa23dfc27eb773e6b34e87f329067393f4f7b616251b3d7d52d294',
  '0xcdfd5294e8b1253263908e1919d27675f80a2e9a3bb339b759810efdbb81faa5',

  // txs between unenrolled routers of
  // USDT/arbitrum-ethereum-mantle-mode-polygon-scroll-zeronetwork
  '0x10159bf1b5b2142b882cb060d1da9f9123d82974ca265ba432138221e52c2a27',

  // test tx when route was first deployed, no merkle tree insertion
  // USDC/ethereum-inevm
  '0x998746dc822dc15332b8683fb8a29aec22ed3e2f2fb8245c40f56303c5cb6032',

  // malformed recipient in warp transfers
  '0xf20e3dc5172d824b146b91bb33d66532915fab605e44d2d76af7b5898a6390fe',
  '0xd4254c0a44ac41f554ebcbb4eff5efd8a9063747e67f9ca4a57ad232e7c8e267',
  '0xad52d640ed71b4363731a78becc8ad1d4aa8549a290c554e48281196478ade83',
  '0x984994d247edd9967182ba91b236a4e10223ef66e3b96259f06f2b7c7fbd8176',

  // oUSDT dest with zero'd out limits
  '0x2ebe41a3c35efaba191765da61b4445d5a01764603bc4635d3d3f62ce65df7d8',
];

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
      tag: 'd3f8da9-20250509-160937',
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
      tag: 'abdf139-20250514-081104',
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
      tag: 'abdf139-20250514-081104',
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
      tag: 'abdf139-20250514-081104',
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
      tag: '385b307-20250418-150728',
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
      tag: 'd3f8da9-20250509-160937',
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
