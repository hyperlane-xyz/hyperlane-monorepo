import {
  Chains,
  GasPaymentEnforcementPolicyType,
  RpcConsensusType,
  chainMetadata,
  getDomainId,
} from '@hyperlane-xyz/sdk';

import {
  AgentChainConfig,
  RootAgentConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config';
import {
  GasPaymentEnforcementConfig,
  routerMatchingList,
} from '../../../src/config/agent/relayer';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment, supportedChainNames } from './chains';
import { helloWorld } from './helloworld';
import { validatorChainConfig } from './validators';
import arbitrumTIAAddresses from './warp/arbitrum-TIA-addresses.json';
import injectiveInevmAddresses from './warp/injective-inevm-addresses.json';
import mantaTIAAddresses from './warp/manta-TIA-addresses.json';

// const releaseCandidateHelloworldMatchingList = routerMatchingList(
//   helloWorld[Contexts.ReleaseCandidate].addresses,
// );

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked / enforced at runtime & in the CI pipeline.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig = {
  [Role.Validator]: {
    [Chains.arbitrum]: true,
    [Chains.avalanche]: true,
    [Chains.bsc]: true,
    [Chains.celo]: true,
    [Chains.ethereum]: true,
    [Chains.neutron]: true,
    [Chains.mantapacific]: true,
    [Chains.moonbeam]: true,
    [Chains.optimism]: true,
    [Chains.polygon]: true,
    [Chains.gnosis]: true,
    [Chains.base]: true,
    [Chains.scroll]: true,
    [Chains.polygonzkevm]: true,
    [Chains.injective]: true,
    [Chains.inevm]: true,
    [Chains.viction]: true,
  },
  [Role.Relayer]: {
    [Chains.arbitrum]: true,
    [Chains.avalanche]: true,
    [Chains.bsc]: true,
    [Chains.celo]: true,
    [Chains.ethereum]: true,
    // At the moment, we only relay between Neutron and Manta Pacific on the neutron context.
    [Chains.neutron]: false,
    [Chains.mantapacific]: false,
    [Chains.moonbeam]: true,
    [Chains.optimism]: true,
    [Chains.polygon]: true,
    [Chains.gnosis]: true,
    [Chains.base]: true,
    [Chains.scroll]: true,
    [Chains.polygonzkevm]: true,
    [Chains.injective]: true,
    [Chains.inevm]: true,
    [Chains.viction]: true,
  },
  [Role.Scraper]: {
    [Chains.arbitrum]: true,
    [Chains.avalanche]: true,
    [Chains.bsc]: true,
    [Chains.celo]: true,
    [Chains.ethereum]: true,
    // Cannot scrape non-EVM chains
    [Chains.neutron]: false,
    [Chains.mantapacific]: true,
    [Chains.moonbeam]: true,
    [Chains.optimism]: true,
    [Chains.polygon]: true,
    [Chains.gnosis]: true,
    [Chains.base]: true,
    [Chains.scroll]: true,
    [Chains.polygonzkevm]: true,
    // Cannot scrape non-EVM chains
    [Chains.injective]: false,
    [Chains.inevm]: true,
    // Has RPC non-compliance that breaks scraping.
    [Chains.viction]: false,
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

const gasPaymentEnforcement: GasPaymentEnforcementConfig[] = [
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
      tag: '54aeb64-20240206-163119',
    },
    gasPaymentEnforcement,
    metricAppContexts: [
      {
        name: 'helloworld',
        matchingList: routerMatchingList(
          helloWorld[Contexts.Hyperlane].addresses,
        ),
      },
      {
        name: 'injective_inevm_inj',
        matchingList: routerMatchingList(injectiveInevmAddresses),
      },
    ],
  },
  validators: {
    docker: {
      repo,
      tag: '54aeb64-20240206-163119',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '54aeb64-20240206-163119',
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
      tag: '54aeb64-20240206-163119',
    },
    // whitelist: releaseCandidateHelloworldMatchingList,
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrum.name],
  },
  validators: {
    docker: {
      repo,
      tag: '54aeb64-20240206-163119',
    },
    rpcConsensusType: RpcConsensusType.Quorum,
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

const neutron: RootAgentConfig = {
  ...contextBase,
  contextChainNames: {
    validator: [],
    relayer: [
      chainMetadata.neutron.name,
      chainMetadata.mantapacific.name,
      chainMetadata.arbitrum.name,
    ],
    scraper: [],
  },
  context: Contexts.Neutron,
  rolesWithKeys: [Role.Relayer],
  relayer: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '54aeb64-20240206-163119',
    },
    gasPaymentEnforcement: [
      {
        type: GasPaymentEnforcementPolicyType.None,
        matchingList: [
          {
            originDomain: getDomainId(chainMetadata.neutron),
            destinationDomain: getDomainId(chainMetadata.mantapacific),
            senderAddress: '*',
            recipientAddress: '*',
          },
          {
            originDomain: getDomainId(chainMetadata.neutron),
            destinationDomain: getDomainId(chainMetadata.arbitrum),
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
