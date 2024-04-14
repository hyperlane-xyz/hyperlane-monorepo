import {
  Chains,
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

import { environment, supportedChainNames } from './chains.js';
import { helloWorld } from './helloworld.js';
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
export const hyperlaneContextAgentChainConfig: AgentChainConfig = {
  [Role.Validator]: {
    [Chains.alfajores]: true,
    [Chains.bsctestnet]: true,
    [Chains.eclipsetestnet]: true,
    [Chains.fuji]: true,
    [Chains.plumetestnet]: true,
    [Chains.scrollsepolia]: true,
    [Chains.sepolia]: true,
    [Chains.solanatestnet]: true,
  },
  [Role.Relayer]: {
    [Chains.alfajores]: true,
    [Chains.bsctestnet]: true,
    [Chains.eclipsetestnet]: true,
    [Chains.fuji]: true,
    [Chains.plumetestnet]: true,
    [Chains.scrollsepolia]: true,
    [Chains.sepolia]: true,
    [Chains.solanatestnet]: true,
  },
  [Role.Scraper]: {
    [Chains.alfajores]: true,
    [Chains.bsctestnet]: true,
    // Cannot scrape non-EVM chains
    [Chains.eclipsetestnet]: false,
    [Chains.fuji]: true,
    [Chains.plumetestnet]: true,
    [Chains.scrollsepolia]: true,
    [Chains.sepolia]: true,
    // Cannot scrape non-EVM chains
    [Chains.solanatestnet]: false,
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
  // Default policy is OnChainFeeQuoting
  {
    type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
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
      tag: '17ac515-20240402-171933',
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
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '17ac515-20240402-171933',
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '17ac515-20240402-171933',
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
      tag: '17ac515-20240402-171933',
    },
    whitelist: [...releaseCandidateHelloworldMatchingList],
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '17ac515-20240402-171933',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
