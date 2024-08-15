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
import { routerMatchingList } from '../../../src/config/agent/relayer.js';
import { ALL_KEY_ROLES, Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { environment } from './chains.js';
import { helloWorld } from './helloworld.js';
import {
  supportedChainNames,
  testnet4SupportedChainNames,
} from './supportedChainNames.js';
import { validatorChainConfig } from './validators.js';
import plumetestnetSepoliaAddresses from './warp/plumetestnet-sepolia-addresses.json';

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
    alfajores: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    connextsepolia: true,
    ecotestnet: true,
    eclipsetestnet: false,
    fuji: true,
    holesky: true,
    optimismsepolia: true,
    plumetestnet: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    superpositiontestnet: true,
  },
  [Role.Relayer]: {
    alfajores: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    connextsepolia: true,
    ecotestnet: true,
    eclipsetestnet: false,
    fuji: true,
    holesky: true,
    optimismsepolia: true,
    plumetestnet: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    solanatestnet: true,
    superpositiontestnet: true,
  },
  [Role.Scraper]: {
    alfajores: true,
    arbitrumsepolia: true,
    basesepolia: true,
    bsctestnet: true,
    connextsepolia: false,
    ecotestnet: true,
    // Cannot scrape non-EVM chains
    eclipsetestnet: false,
    fuji: true,
    holesky: true,
    optimismsepolia: true,
    plumetestnet: true,
    polygonamoy: true,
    scrollsepolia: true,
    sepolia: true,
    // Cannot scrape non-EVM chains
    solanatestnet: false,
    superpositiontestnet: false,
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

const hyperlane: RootAgentConfig = {
  ...contextBase,
  contextChainNames: hyperlaneContextAgentChainNames,
  context: Contexts.Hyperlane,
  rolesWithKeys: ALL_KEY_ROLES,
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '874a58f-20240812-172417',
    },
    blacklist: [
      ...releaseCandidateHelloworldMatchingList,
      {
        // In an effort to reduce some giant retry queues that resulted
        // from spam txs to the old TestRecipient before we were charging for
        // gas, we blacklist the old TestRecipient address.
        recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
      },
    ],
    gasPaymentEnforcement,
    metricAppContexts: [
      {
        name: 'helloworld',
        matchingList: routerMatchingList(
          helloWorld[Contexts.Hyperlane].addresses,
        ),
      },
      {
        name: 'plumetestnet_sepolia_eth',
        matchingList: routerMatchingList(plumetestnetSepoliaAddresses),
      },
    ],
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '874a58f-20240812-172417',
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
    resources: validatorResources,
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '874a58f-20240812-172417',
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
      tag: '0d12ff3-20240620-173353',
    },
    whitelist: [...releaseCandidateHelloworldMatchingList],
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    resources: relayerResources,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '0d12ff3-20240620-173353',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
    resources: validatorResources,
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
