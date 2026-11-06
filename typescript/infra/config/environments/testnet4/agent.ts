import {
  ChainName,
  GasPaymentEnforcement,
  GasPaymentEnforcementPolicyType,
  IsmCacheConfig,
  IsmCachePolicy,
  IsmCacheSelectorType,
  ModuleType,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  AgentChainConfig,
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config/agent/agent.js';
import { BaseRelayerConfig } from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts, RELEASE_CANDIDATE_INDEX_FROM } from '../../contexts.js';
import { DockerImageRepos, testnetDockerTags } from '../../docker.js';
import { getDomainId } from '../../registry.js';
import { fallbackHedgeConfig } from '../utils.js';

import { environment, ethereumChainNames } from './chains.js';
import {
  supportedChainNames,
  testnet4SupportedChainNames,
} from './supportedChainNames.js';
import {
  fastPathReorgPeriodOverrides,
  validatorChainConfig,
} from './validators.js';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked / enforced at runtime & in the CI pipeline.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig<
  typeof testnet4SupportedChainNames
> = {
  [Role.Validator]: {
    aleotestnet: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    hyperliquidevmtestnet: true,
    optimismsepolia: true,
    polygonamoy: true,
    seismictestnet: true,
    sepolia: true,
    solanadevnet: true,
    solanatestnet: true,
    somniatestnet: true,
    tronshasta: true,
  },
  [Role.Relayer]: {
    aleotestnet: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    hyperliquidevmtestnet: true,
    optimismsepolia: true,
    polygonamoy: true,
    seismictestnet: true,
    sepolia: true,
    solanadevnet: true,
    solanatestnet: true,
    somniatestnet: true,
    tronshasta: true,
  },
  [Role.Scraper]: {
    aleotestnet: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    hyperliquidevmtestnet: true,
    optimismsepolia: true,
    polygonamoy: true,
    // disabled temporarily until timestamps change from ms to secs (soon)
    seismictestnet: false,
    sepolia: true,
    solanadevnet: true,
    solanatestnet: true,
    somniatestnet: true,
    tronshasta: true,
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
  gcp: {
    project: 'abacus-labs-dev',
    location: 'us-east1',
  },
  sealevel: {
    maxSupportedTransactionVersionGetter: (chain: ChainName): 0 | 1 =>
      chain === 'solanadevnet' || chain === 'solanatestnet' ? 1 : 0,
  },
} as const;

// Diagnostics share the mainnet database; origin/destination domains identify chains.
const messageActivityDatabaseUrlSecret =
  'hyperlane-testnet4-relayer-postgres-writer-url';
const diagnosticsDatabaseSecret =
  'hyperlane-testnet4-relayer-postgres-reader-url';

const scraperWebsocketUrl =
  'ws://scraper-proxy.testnet4.svc.cluster.local:8383/agents';

const gasPaymentEnforcement: GasPaymentEnforcement[] = [
  {
    type: GasPaymentEnforcementPolicyType.Minimum,
    payment: '1',
    matchingList: [
      // Workaround for gas price fluctuations
      // Works in tandem with increased igp overhead
      {
        destinationDomain: getDomainId('somniatestnet'),
      },
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
];

const processAltOverrides: BaseRelayerConfig['processAltOverrides'] = {
  solanatestnet: [
    {
      matchingList: [
        {
          recipientAddress: addressToBytes32(
            'mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X',
          ),
        },
      ],
      addressLookupTable: '4zybokQ8gLLPWUawXaw1JhrPZZsTaTGeaHZhLLb5nPhS',
    },
  ],
};

const runtimeDenylist = {
  url: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/relayer/testnet-denylist.json',
  pollIntervalSecs: 60,
};

const hyperlane: RootAgentConfig = {
  ...contextBase,
  contextChainNames: hyperlaneContextAgentChainNames,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    messageActivityDatabaseUrlSecret,
    rpcConsensusType: RpcConsensusType.Fallback,
    ...fallbackHedgeConfig,
    websocketUrl: scraperWebsocketUrl,
    websocketAuthorityEnabled: false,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.relayer,
    },
    runtimeDenylist,
    gasPaymentEnforcement,
    ismCacheConfigs,
    processAltOverrides,
    cache: {
      enabled: true,
    },
    relayApi: {
      enabled: true,
      port: 8900,
      rateLimitMaxRequests: 100,
      rateLimitWindowSecs: 60,
      corsOrigins: 'https://nexus.hyperlane.xyz',
    },
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Majority,
    websocketUrl: scraperWebsocketUrl,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.validator,
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    websocketConfigSecret: 'hyperlane-testnet4-scraper3-websocket-config',
    rpcConsensusType: RpcConsensusType.Fallback,
    ...fallbackHedgeConfig,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.scraper,
    },
    resources: scraperResources,
  },
  scraperProxy: {
    diagnosticsDatabaseSecret,
    docker: {
      repo: DockerImageRepos.NODE_SERVICES,
      tag: testnetDockerTags.scraperProxy,
    },
    enabled: true,
    maxAgentClients: 100,
    port: 8383,
    replicas: 1,
    tunnel: { enabled: false },
    resources: {
      requests: { cpu: '500m', memory: '1Gi' },
    },
  },
};

const releaseCandidate: RootAgentConfig = {
  ...contextBase,
  context: Contexts.ReleaseCandidate,
  contextChainNames: hyperlaneContextAgentChainNames,
  rolesWithKeys: [Role.Relayer, Role.Validator],
  relayer: {
    messageActivityDatabaseUrlSecret,
    rpcConsensusType: RpcConsensusType.Fallback,
    ...fallbackHedgeConfig,
    index: { from: RELEASE_CANDIDATE_INDEX_FROM },
    websocketUrl: scraperWebsocketUrl,
    websocketAuthorityEnabled: false,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.relayerRC,
    },
    runtimeDenylist,
    gasPaymentEnforcement,
    ismCacheConfigs,
    processAltOverrides,
    cache: {
      enabled: true,
    },
    relayApi: {
      enabled: true,
      port: 8900,
      rateLimitMaxRequests: 100,
      rateLimitWindowSecs: 60,
      corsOrigins: 'https://nexus.hyperlane.xyz,http://localhost:3000',
    },
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Majority,
    websocketUrl: scraperWebsocketUrl,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.validatorRC,
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
    resources: validatorResources,
  },
};

const fastPath: RootAgentConfig = {
  ...contextBase,
  context: Contexts.FastPath,
  contextChainNames: {
    [Role.Validator]: ['arbitrumsepolia', 'basesepolia', 'sepolia'],
    [Role.Relayer]: ['arbitrumsepolia', 'basesepolia', 'sepolia'],
    [Role.Scraper]: [],
  },
  rolesWithKeys: [Role.Relayer, Role.Validator],
  relayer: {
    messageActivityDatabaseUrlSecret,
    rpcConsensusType: RpcConsensusType.Fallback,
    ...fallbackHedgeConfig,
    // Use RPC indexing until the scraper proxy supports fastpath streaming.
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.relayerFastPath,
    },
    gasPaymentEnforcement,
    reorgPeriodOverrides: fastPathReorgPeriodOverrides,
    runtimeDenylist,
    ismCacheConfigs,
    cache: {
      enabled: true,
    },
    // Halve steady-state index polling RPCs while keeping fastpath detection
    // within one additional second (0.5s average).
    interval: 2,
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Majority,
    websocketUrl: scraperWebsocketUrl,
    docker: {
      repo: DockerImageRepos.AGENT,
      tag: testnetDockerTags.validatorFastPath,
    },
    chains: validatorChainConfig(Contexts.FastPath),
    resources: validatorResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.FastPath]: fastPath,
};
