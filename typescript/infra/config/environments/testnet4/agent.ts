import {
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
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config/agent/agent.js';
import {
  BaseRelayerConfig,
  MetricAppContext,
  routerMatchingList,
} from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts, mustBeValidContext } from '../../contexts.js';
import { getDomainId } from '../../registry.js';

import { environment, ethereumChainNames } from './chains.js';
import { helloWorld } from './helloworld.js';
import {
  supportedChainNames,
  testnet4SupportedChainNames,
} from './supportedChainNames.js';
import { validatorChainConfig } from './validators.js';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked / enforced at runtime & in the CI pipeline.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig<
  typeof testnet4SupportedChainNames
> = {
  [Role.Validator]: {
    abstracttestnet: true,
    alephzeroevmtestnet: true,
    alfajores: true,
    arbitrumsepolia: true,
    arcadiatestnet2: true,
    auroratestnet: true,
    basesepolia: true,
    bsctestnet: true,
    camptestnet: true,
    carrchaintestnet: true,
    chronicleyellowstone: true,
    citreatestnet: true,
    connextsepolia: true,
    cotitestnet: true,
    ecotestnet: true,
    eclipsetestnet: false,
    flametestnet: true,
    formtestnet: true,
    fuji: true,
    holesky: true,
    hyperliquidevmtestnet: true,
    infinityvmmonza: true,
    inksepolia: true,
    kyvetestnet: false,
    milkywaytestnet: true,
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    paradexsepolia: true,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    soneiumtestnet: true,
    somniatestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: true,
    starknetsepolia: true,
    suavetoliman: true,
    subtensortestnet: true,
    superpositiontestnet: true,
    treasuretopaz: true,
    unichaintestnet: true,
    weavevmtestnet: true,
  },
  [Role.Relayer]: {
    abstracttestnet: true,
    alephzeroevmtestnet: true,
    alfajores: true,
    arbitrumsepolia: true,
    arcadiatestnet2: true,
    auroratestnet: true,
    basesepolia: true,
    bsctestnet: true,
    camptestnet: true,
    carrchaintestnet: true,
    chronicleyellowstone: true,
    citreatestnet: true,
    connextsepolia: true,
    cotitestnet: true,
    ecotestnet: true,
    eclipsetestnet: false,
    flametestnet: true,
    formtestnet: true,
    fuji: true,
    holesky: true,
    hyperliquidevmtestnet: false,
    infinityvmmonza: true,
    inksepolia: true,
    kyvetestnet: false,
    milkywaytestnet: true,
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    paradexsepolia: true,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    soneiumtestnet: true,
    somniatestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: true,
    starknetsepolia: true,
    suavetoliman: true,
    subtensortestnet: true,
    superpositiontestnet: true,
    treasuretopaz: true,
    unichaintestnet: true,
    weavevmtestnet: true,
  },
  [Role.Scraper]: {
    abstracttestnet: true,
    alephzeroevmtestnet: true,
    alfajores: true,
    arbitrumsepolia: true,
    arcadiatestnet2: false,
    auroratestnet: true,
    basesepolia: true,
    bsctestnet: true,
    camptestnet: true,
    carrchaintestnet: true,
    chronicleyellowstone: true,
    citreatestnet: true,
    connextsepolia: false,
    cotitestnet: true,
    ecotestnet: true,
    eclipsetestnet: false,
    flametestnet: true,
    formtestnet: true,
    fuji: true,
    holesky: true,
    hyperliquidevmtestnet: false,
    infinityvmmonza: true,
    inksepolia: true,
    kyvetestnet: false,
    milkywaytestnet: true,
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    paradexsepolia: false,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: false,
    somniatestnet: true,
    soneiumtestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: false,
    starknetsepolia: false,
    suavetoliman: true,
    subtensortestnet: true,
    superpositiontestnet: false,
    treasuretopaz: true,
    unichaintestnet: true,
    weavevmtestnet: true,
  },
};

export const hyperlaneContextAgentChainNames = getAgentChainNamesFromConfig(
  hyperlaneContextAgentChainConfig,
  testnet4SupportedChainNames,
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
      // Temporary workaround for testing milkywaytestnet->bsctestnet.
      {
        originDomain: getDomainId('milkywaytestnet'),
        destinationDomain: getDomainId('bsctestnet'),
      },
      // Temporary workaround for testing bsctestnet->milkywaytestnet.
      {
        originDomain: getDomainId('bsctestnet'),
        destinationDomain: getDomainId('milkywaytestnet'),
      },
    ],
  },
  {
    type: GasPaymentEnforcementPolicyType.None,
    matchingList: [
      // Temporary workaround due to InfinityVM Monza whitelisting.
      { originDomain: getDomainId('infinityvmmonza') },
      // Temporary workaround due to InfinityVM Monza whitelisting.
      { destinationDomain: getDomainId('infinityvmmonza') },
    ],
  },
  // Default policy is OnChainFeeQuoting
  {
    type: GasPaymentEnforcementPolicyType.None,
  },
];

// Resource requests are based on observed usage found in https://abacusworks.grafana.net/d/FSR9YWr7k
const relayerResources = {
  requests: {
    cpu: '1000m',
    memory: '4Gi',
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
    memory: '1Gi',
  },
};

// Kessel is a load test, these are contracts involved in the load
// test that we want to have certain relayers focus on or ignore.
const kesselMatchingList: MatchingList = [
  // classic kessel test recipient
  {
    recipientAddress: '0x492b3653A38e229482Bab2f7De4A094B18017246',
  },
  // kessel run spice route
  {
    destinationDomain: getDomainId('basesepolia'),
    recipientAddress: '0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
  },
  {
    destinationDomain: getDomainId('bsctestnet'),
    recipientAddress: '0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
  },
  {
    destinationDomain: getDomainId('optimismsepolia'),
    recipientAddress: '0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
  },
  {
    destinationDomain: getDomainId('arbitrumsepolia'),
    recipientAddress: '0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
  },
  {
    destinationDomain: getDomainId('sepolia'),
    recipientAddress: '0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
  },
];

const kesselAppContext = 'kessel';

const metricAppContextsGetter = (): MetricAppContext[] => [
  {
    name: 'helloworld',
    matchingList: routerMatchingList(helloWorld[Contexts.Hyperlane].addresses),
  },
  {
    name: kesselAppContext,
    matchingList: kesselMatchingList,
  },
];

const ismCacheConfigs: Array<IsmCacheConfig> = [
  {
    selector: {
      type: IsmCacheSelectorType.DefaultIsm,
    },
    // Default ISM Routing ISMs change configs based off message content,
    // so they are not specified here.
    moduleTypes: [
      ModuleType.AGGREGATION,
      ModuleType.MERKLE_ROOT_MULTISIG,
      ModuleType.MESSAGE_ID_MULTISIG,
    ],
    // SVM is explicitly not cached as the default ISM is a multisig ISM
    // that routes internally.
    chains: ethereumChainNames,
    cachePolicy: IsmCachePolicy.IsmSpecific,
  },
  {
    selector: {
      type: IsmCacheSelectorType.AppContext,
      context: kesselAppContext,
    },
    // Default ISM Routing ISMs change configs based off message content,
    // so they are not specified here.
    moduleTypes: [
      ModuleType.AGGREGATION,
      ModuleType.MERKLE_ROOT_MULTISIG,
      ModuleType.MESSAGE_ID_MULTISIG,
      ModuleType.ROUTING,
    ],
    // SVM is explicitly not cached as the default ISM is a multisig ISM
    // that routes internally.
    chains: ethereumChainNames,
    cachePolicy: IsmCachePolicy.IsmSpecific,
  },
];

const relayBlacklist: BaseRelayerConfig['blacklist'] = [
  // Ignore kessel runner test recipients.
  // All 5 test recipients have the same address.
  ...kesselMatchingList,
  {
    // In an effort to reduce some giant retry queues that resulted
    // from spam txs to the old TestRecipient before we were charging for
    // gas, we blacklist the old TestRecipient address.
    recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
  },
  // Ignore load testing done by Mitosis from sepolia when they used a different Mailbox on
  // arbitrumsepolia and optimismsepolia.
  {
    originDomain: getDomainId('sepolia'),
    senderAddress: '0xb6f4a8dccac0beab1062212f4665879d9937c83c',
    destinationDomain: getDomainId('arbitrumsepolia'),
    recipientAddress: '0x3da95d8d0b98d7428dc2f864511e2650e34f7087',
  },
  {
    originDomain: getDomainId('sepolia'),
    senderAddress: '0xb6f4a8dccac0beab1062212f4665879d9937c83c',
    destinationDomain: getDomainId('optimismsepolia'),
    recipientAddress: '0xa49942c908ec50db14652914317518661ec04904',
  },
];

const hyperlane: RootAgentConfig = {
  ...contextBase,
  contextChainNames: hyperlaneContextAgentChainNames,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '385b307-20250418-150728',
    },
    blacklist: [...releaseCandidateHelloworldMatchingList, ...relayBlacklist],
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '7411c6f-20250428-161515',
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: 'd9e0b4b-20250425-145730',
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
      tag: '391c097-20250428-141206',
    },
    blacklist: relayBlacklist,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '385b307-20250418-150728',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
    resources: validatorResources,
  },
};

export const kesselRunnerNetworks = [
  'basesepolia',
  'arbitrumsepolia',
  'sepolia',
  'bsctestnet',
  'optimismsepolia',
];
const neutron: RootAgentConfig = {
  ...contextBase,
  context: Contexts.Neutron,
  contextChainNames: {
    validator: [],
    relayer: kesselRunnerNetworks,
    scraper: [],
  },
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '385b307-20250418-150728',
    },
    whitelist: kesselMatchingList,
    gasPaymentEnforcement,
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
      // Cache for 10 minutes
      defaultExpirationSeconds: 10 * 60,
    },
    resources: {
      requests: {
        cpu: '20000m',
        memory: '32Gi',
      },
    },
  },
};

const getVanguardRootAgentConfig = (index: number): RootAgentConfig => ({
  ...contextBase,
  context: mustBeValidContext(`vanguard${index}`),
  contextChainNames: {
    validator: [],
    relayer: kesselRunnerNetworks,
    scraper: [],
  },
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      // includes gasPriceCap overrides + per-chain maxSubmitQueueLength
      tag: '9d20c65-20250418-220918',
    },
    whitelist: kesselMatchingList,
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: kesselMatchingList,
      },
    ],
    metricAppContextsGetter,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    resources: {
      requests: {
        cpu: '30000m',
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
        sepolia: 26,
      },
      bypassBatchSimulation: true,
      maxSubmitQueueLength: {
        arbitrumsepolia: 350,
        basesepolia: 350,
        bsctestnet: 350,
        optimismsepolia: 350,
        sepolia: 75,
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
