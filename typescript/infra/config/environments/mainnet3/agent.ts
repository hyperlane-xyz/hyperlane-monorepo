import {
  AgentSealevelHeliusFeeLevel,
  AgentSealevelPriorityFeeOracle,
  AgentSealevelPriorityFeeOracleType,
  AgentSealevelTransactionSubmitter,
  AgentSealevelTransactionSubmitterType,
  ChainMap,
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
import { Address, objMap } from '@hyperlane-xyz/utils';

import {
  AgentChainConfig,
  HELIUS_SECRET_URL_MARKER,
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config/agent/agent.js';
import {
  IcaMessageType,
  MetricAppContext,
  chainMapMatchingList,
  consistentSenderRecipientMatchingList,
  icaMatchingList,
  matchingList,
  routerMatchingList,
  senderMatchingList,
  warpRouteMatchingList,
} from '../../../src/config/agent/relayer.js';
import { BaseScraperConfig } from '../../../src/config/agent/scraper.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getDomainId, getWarpAddresses } from '../../registry.js';

import { environment, ethereumChainNames } from './chains.js';
import { blacklistedMessageIds } from './customBlacklist.js';
import { helloWorld } from './helloworld.js';
import aaveSenderAddresses from './misc-artifacts/aave-sender-addresses.json' with { type: 'json' };
import everclearSenderAddresses from './misc-artifacts/everclear-sender-addresses.json' with { type: 'json' };
import {
  default as merklyErc20Addresses,
  default as merklyEthAddresses,
  default as merklyNftAddresses,
} from './misc-artifacts/merkly-eth-addresses.json' with { type: 'json' };
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
    adichain: true,
    aleo: true,
    ancient8: true,
    apechain: true,
    appchain: true,
    arbitrum: true,
    arbitrumnova: true,
    arcadia: true,
    artela: true,
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
    bsc: true,
    bsquared: true,
    carrchain: true,
    celestia: true,
    celo: true,
    chilizmainnet: true,
    citrea: true,
    coredao: true,
    coti: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    eclipsemainnet: true,
    electroneum: true,
    endurance: true,
    eni: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: false, // chain in recovery mode
    fluence: true,
    forma: false, // relayer + scraper only
    fraxtal: true,
    fusemainnet: true,
    galactica: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    incentiv: true,
    ink: true,
    kaia: true,
    katana: true,
    krown: true,
    kyve: true,
    lazai: true,
    linea: true,
    lisk: true,
    litchain: true,
    lukso: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    mantra: true,
    matchain: true,
    megaeth: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    miraclechain: true,
    mitosis: true,
    mode: true,
    molten: true,
    monad: true,
    moonbeam: true,
    morph: true,
    neutron: true,
    nibiru: true,
    noble: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    paradex: true,
    peaq: true,
    plasma: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    pulsechain: true,
    radix: true,
    rarichain: true,
    reactive: true,
    redstone: true,
    ronin: true,
    scroll: true,
    sei: true,
    shibarium: true,
    solanamainnet: true,
    solaxy: true,
    somnia: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    stable: true,
    starknet: true,
    story: true,
    stride: false,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    swell: true,
    tac: true,
    taiko: true,
    tangle: true,
    torus: true,
    unichain: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    xrplevm: true,
    zerogravity: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Relayer]: {
    abstract: true,
    // acala: true,
    aleo: true,
    adichain: true,
    ancient8: true,
    apechain: true,
    appchain: true,
    arcadia: true,
    arbitrum: true,
    arbitrumnova: true,
    artela: true,
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
    bsc: true,
    bsquared: true,
    carrchain: true,
    celestia: true,
    celo: true,
    chilizmainnet: true,
    citrea: true,
    coredao: true,
    coti: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    eclipsemainnet: true,
    electroneum: true,
    endurance: true,
    eni: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: false,
    fluence: true,
    forma: true,
    fraxtal: true,
    fusemainnet: true,
    galactica: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    incentiv: true,
    ink: true,
    kaia: true,
    katana: true,
    krown: true,
    kyve: true,
    lazai: true,
    linea: true,
    lisk: true,
    litchain: true,
    lukso: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    mantra: true,
    matchain: true,
    megaeth: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    miraclechain: true,
    mitosis: true,
    mode: true,
    molten: true,
    monad: true,
    moonbeam: true,
    morph: true,
    neutron: true,
    nibiru: true,
    noble: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    paradex: true,
    peaq: true,
    plasma: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    pulsechain: true,
    radix: true,
    rarichain: true,
    reactive: true,
    redstone: true,
    ronin: true,
    scroll: true,
    sei: true,
    shibarium: true,
    solanamainnet: true,
    solaxy: true,
    somnia: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    stable: true,
    starknet: true,
    story: true,
    stride: true,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    swell: true,
    tac: true,
    taiko: true,
    tangle: true,
    torus: true,
    unichain: true,
    vana: true,
    viction: true,
    worldchain: true,
    xai: true,
    xlayer: true,
    xrplevm: true,
    zerogravity: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
  [Role.Scraper]: {
    abstract: true,
    // acala: true,
    aleo: true,
    adichain: true,
    ancient8: true,
    apechain: true,
    appchain: true,
    arbitrum: true,
    arbitrumnova: true,
    arcadia: true,
    artela: true,
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
    bsc: true,
    bsquared: true,
    carrchain: true,
    celestia: true,
    celo: true,
    chilizmainnet: true,
    citrea: true,
    coredao: true,
    coti: true,
    cyber: true,
    degenchain: true,
    dogechain: true,
    eclipsemainnet: true,
    electroneum: true,
    endurance: true,
    eni: true,
    ethereum: true,
    everclear: true,
    fantom: true,
    flare: true,
    flowmainnet: false, // chain in recovery mode
    fluence: true,
    forma: true,
    fraxtal: true,
    fusemainnet: true,
    galactica: true,
    gnosis: true,
    gravity: true,
    harmony: true,
    hashkey: true,
    hemi: true,
    hyperevm: true,
    immutablezkevmmainnet: true,
    incentiv: true,
    ink: true,
    kaia: true,
    katana: true,
    krown: true,
    kyve: true,
    lazai: true,
    linea: true,
    lisk: true,
    litchain: true,
    lukso: true,
    lumiaprism: true,
    mantapacific: true,
    mantle: true,
    mantra: true,
    matchain: true,
    megaeth: true,
    merlin: true,
    metal: true,
    metis: true,
    milkyway: true,
    miraclechain: true,
    mitosis: true,
    mode: true,
    molten: true,
    monad: true,
    moonbeam: true,
    morph: true,
    neutron: true,
    nibiru: true,
    noble: true,
    oortmainnet: true,
    ontology: true,
    opbnb: true,
    optimism: true,
    orderly: true,
    paradex: true,
    peaq: true,
    plasma: true,
    plume: true,
    polygon: true,
    polygonzkevm: true,
    polynomialfi: true,
    prom: true,
    pulsechain: true,
    radix: true,
    rarichain: true,
    reactive: true,
    redstone: true,
    ronin: true,
    scroll: true,
    sei: true,
    shibarium: true,
    solanamainnet: true,
    solaxy: true,
    somnia: true,
    soneium: true,
    sonic: true,
    sonicsvm: true,
    soon: true,
    sophon: true,
    stable: true,
    starknet: true,
    story: true,
    stride: true,
    subtensor: true,
    superseed: true,
    superpositionmainnet: true,
    swell: true,
    tac: true,
    taiko: true,
    tangle: true,
    torus: true,
    unichain: true,
    vana: true,
    // Has RPC non-compliance that breaks scraping.
    viction: false,
    worldchain: true,
    xai: true,
    xlayer: true,
    xrplevm: true,
    zerogravity: true,
    zeronetwork: true,
    zetachain: true,
    zircuit: true,
    zksync: true,
    zoramainnet: true,
  },
};

// Chains not in our core set of supported chains, and supported ONLY by the scraper
export const scraperOnlyChains: BaseScraperConfig['scraperOnlyChains'] = {
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

const veloMessageModuleMatchingList = consistentSenderRecipientMatchingList(
  '0x2BbA7515F7cF114B45186274981888D8C2fBA15E',
);

// Velodrome Universal Router addresses (also used by Superswap)
// Source: https://github.com/velodrome-finance/universal-router/tree/main/deployment-addresses
const velodromeUniversalRouterOwner =
  '0x01D40099fCD87C018969B0e8D4aB1633Fb34763C';

const velodromeUniversalRouters: ChainMap<Address> = {
  base: velodromeUniversalRouterOwner,
  celo: velodromeUniversalRouterOwner,
  fraxtal: velodromeUniversalRouterOwner,
  ink: velodromeUniversalRouterOwner,
  lisk: velodromeUniversalRouterOwner,
  metal: velodromeUniversalRouterOwner,
  mode: velodromeUniversalRouterOwner,
  optimism: velodromeUniversalRouterOwner,
  soneium: velodromeUniversalRouterOwner,
  superseed: velodromeUniversalRouterOwner,
  swell: velodromeUniversalRouterOwner,
  unichain: velodromeUniversalRouterOwner,
};

const superswapIcaV2CommitmentMatchingList = icaMatchingList(
  objMap(velodromeUniversalRouters, (_, owner) => ({
    messageType: IcaMessageType.COMMITMENT,
    owner,
  })),
);

const icaV2RevealMatchingList = icaMatchingList(
  objMap(velodromeUniversalRouters, () => ({
    messageType: IcaMessageType.REVEAL,
  })),
);

const gasPaymentEnforcement: GasPaymentEnforcement[] = [
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: [
      { originDomain: getDomainId('noble') },
      { originDomain: getDomainId('starknet') },
      { originDomain: getDomainId('paradex') },
      // Not a core chain
      {
        originDomain: getDomainId('forma'),
        destinationDomain: getDomainId('stride'),
      },
      // Not a core chain
      {
        originDomain: getDomainId('stride'),
        destinationDomain: getDomainId('forma'),
      },
      // Not a core chain
      {
        originDomain: getDomainId('forma'),
        destinationDomain: getDomainId('celestia'),
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
      // Not a core chain
      { destinationDomain: getDomainId('forma') },
      // Temporary workaround due to funky Zeronetwork gas amounts.
      { destinationDomain: getDomainId('zeronetwork') },
      // Temporary workaround during testing of MilkyWay.
      { originDomain: getDomainId('milkyway') },
      // Being more generous with some Velo message module messages, which occasionally underpay
      ...veloMessageModuleMatchingList,
      // Superswap ICA matches on ICA owner address in message body
      ...superswapIcaV2CommitmentMatchingList,
      // ICA reveal messages (does not filter on ICA owner)
      ...icaV2RevealMatchingList,
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

// Gets metric app contexts, including:
// - helloworld
// - all warp routes defined in WarpRouteIds, using addresses from the registry
// - misc important applications not defined in the registry, e.g. merkly
const metricAppContextsGetter = (): MetricAppContext[] => {
  const warpContexts = Object.values(WarpRouteIds).map((warpRouteId) => {
    let warpMatchingList = undefined;

    // oUSDT has some remote routers but that don't have any limits set yet.
    // Some people have been sending to e.g. Ink outside the UI, so to reduce alert noise
    // we remove these from the matching list.
    // TODO: once Ink or Worldchain have limits set, we should remove this.
    if (warpRouteId === WarpRouteIds.oUSDT) {
      const ousdtAddresses = getWarpAddresses(warpRouteId);
      delete ousdtAddresses['ink'];
      delete ousdtAddresses['worldchain'];
      warpMatchingList = matchingList(ousdtAddresses);
    } else {
      warpMatchingList = warpRouteMatchingList(warpRouteId);
    }

    return {
      name: warpRouteId,
      matchingList: warpMatchingList,
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
      matchingList: veloMessageModuleMatchingList,
    },
    {
      name: 'velo_token_bridge',
      // All messages to / from this address relate to the Velo Token Bridge.
      matchingList: consistentSenderRecipientMatchingList(
        '0x1A9d17828897d6289C6dff9DC9F5cc3bAEa17814',
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
    {
      name: 'superswap_ica_v2',
      matchingList: [
        ...superswapIcaV2CommitmentMatchingList,
        // WARN: does not only reflect superswaps messages
        ...icaV2RevealMatchingList,
      ],
    },
    {
      name: 'm0',
      matchingList: consistentSenderRecipientMatchingList(
        '0x36f586A30502AE3afb555b8aA4dCc05d233c2ecE',
      ),
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
  // legacy forma routes we are not relaying
  {
    destinationDomain: getDomainId('forma'),
    recipientAddress: [
      '0x4ca56fbecfe8431996c6b4ec8da140d4201338e8',
      '0x0a5c7d4ee3d65b2581d5606f8081fc8d8be22319',
      '0x74a26075fa2eec77936a56b0f9645d32a79b28af',
      '0xfcee86f472d0c19fccdd3aedb89aa9cc0a1fb0d1',
    ],
  },
  // legacy forma routes we are not relaying
  {
    originDomain: getDomainId('forma'),
    senderAddress: [
      '0x6052c5c075212f013c856bff015872914ed3492a',
      '0xd5ebc5e5f38c2d8c91c43122a105327c1f0260b4',
    ],
  },
  // routes on legacy pulsechain mailbox
  {
    destinationDomain: getDomainId('pulsechain'),
    recipientAddress: [
      '0x688B161745c4eCEc2Ce07DC385cF2B57D9980244',
      '0x50d03965Ed30de5d246BdDa18E7B10A8904B8CF1',
      '0xD110Cbf543c3b237aB3EC171D7117932A4807F9B',
      '0x87353B9AA546F8cf7290DeD2d339C0Ec694d7144',
      '0x5DD749B87FA2e456482adb231FB9c2b0302A3027',
      '0xe227B51F5D7079fAa07b7621657e3aa5906d2185',
      '0x867c1fd9341DEC12e4B779C35D7b7C475316b334',
    ],
  },
  // StarkNet<>StarkNet messages
  {
    originDomain: getDomainId('starknet'),
    destinationDomain: getDomainId('starknet'),
  },
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
      tag: '28f67ad-20260103-234517',
    },
    blacklist,
    gasPaymentEnforcement: gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    batch: {
      batchSizeOverrides: {
        starknet: 16,
        paradex: 16,
      },
    },
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: '28f67ad-20260103-234517',
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
      tag: '28f67ad-20260103-234517',
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
      tag: '28f67ad-20260103-234517',
    },
    blacklist,
    // We're temporarily (ab)using the RC relayer as a way to increase
    // message throughput.
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    batch: {
      batchSizeOverrides: {
        starknet: 16,
        paradex: 16,
      },
    },
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    docker: {
      repo,
      tag: '28f67ad-20260103-234517',
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
    relayer: ['mantapacific', 'arbitrum'],
    scraper: [],
  },
  context: Contexts.Neutron,
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'cd94774-20251217-100437',
    },
    blacklist,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    batch: {
      batchSizeOverrides: {
        starknet: 16,
        paradex: 16,
      },
    },
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: neutron,
};
