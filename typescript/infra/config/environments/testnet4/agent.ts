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
  BaseRelayerConfig,
  routerMatchingList,
} from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { getDomainId } from '../../registry.js';

import { environment } from './chains.js';
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
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    soneiumtestnet: true,
    somniatestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: true,
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
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    soneiumtestnet: true,
    somniatestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: true,
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
    modetestnet: true,
    monadtestnet: true,
    odysseytestnet: true,
    optimismsepolia: true,
    plumetestnet2: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: false,
    somniatestnet: true,
    soneiumtestnet: true,
    sonicblaze: true,
    sonicsvmtestnet: false,
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
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
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

const relayBlacklist: BaseRelayerConfig['blacklist'] = [
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
      tag: '45739bd-20250401-014114',
    },
    blacklist: [...releaseCandidateHelloworldMatchingList, ...relayBlacklist],
    gasPaymentEnforcement,
    metricAppContextsGetter: () => [
      {
        name: 'helloworld',
        matchingList: routerMatchingList(
          helloWorld[Contexts.Hyperlane].addresses,
        ),
      },
    ],
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '45739bd-20250401-014114',
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '45739bd-20250401-014114',
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
      tag: '8c3e983-20250310-144838',
    },
    whitelist: [...releaseCandidateHelloworldMatchingList],
    blacklist: relayBlacklist,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '73c232b-20240912-124300',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
    resources: validatorResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
