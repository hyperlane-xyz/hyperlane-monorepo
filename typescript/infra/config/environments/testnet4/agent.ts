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
  routerMatchingList,
} from '../../../src/config';
import { GasPaymentEnforcementConfig } from '../../../src/config/agent/relayer';
import { ALL_KEY_ROLES, Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment, supportedChainNames } from './chains';
import { helloWorld } from './helloworld';
import { validatorChainConfig } from './validators';
import plumetestnetSepoliaAddresses from './warp/plumetestnet-sepolia-addresses.json';

const releaseCandidateHelloworldMatchingList = routerMatchingList(
  helloWorld[Contexts.ReleaseCandidate].addresses,
);

const repo = 'gcr.io/abacus-labs-dev/hyperlane-agent';

// The chains here must be consistent with the environment's supportedChainNames, which is
// checked & enforced at runtime.
//
// This is intentionally separate and not derived from the environment's supportedChainNames
// to allow for more fine-grained control over which chains are enabled for each agent role.
export const hyperlaneContextAgentChainConfig: AgentChainConfig = {
  [Role.Validator]: {
    [Chains.alfajores]: true,
    [Chains.arbitrumgoerli]: true,
    [Chains.bsctestnet]: true,
    [Chains.eclipsetestnet]: true,
    [Chains.fuji]: true,
    [Chains.goerli]: true,
    [Chains.mumbai]: true,
    [Chains.optimismgoerli]: true,
    [Chains.plumetestnet]: true,
    [Chains.polygonzkevmtestnet]: true,
    [Chains.scrollsepolia]: true,
    [Chains.sepolia]: true,
    [Chains.solanatestnet]: true,
  },
  [Role.Relayer]: {
    [Chains.alfajores]: true,
    [Chains.arbitrumgoerli]: true,
    [Chains.bsctestnet]: true,
    [Chains.eclipsetestnet]: true,
    [Chains.fuji]: true,
    [Chains.goerli]: true,
    [Chains.mumbai]: true,
    [Chains.optimismgoerli]: true,
    [Chains.plumetestnet]: true,
    [Chains.polygonzkevmtestnet]: true,
    [Chains.scrollsepolia]: true,
    [Chains.sepolia]: true,
    [Chains.solanatestnet]: true,
  },
  [Role.Scraper]: {
    [Chains.alfajores]: true,
    [Chains.arbitrumgoerli]: true,
    [Chains.bsctestnet]: true,
    // Cannot scrape non-EVM chains
    [Chains.eclipsetestnet]: false,
    [Chains.fuji]: true,
    [Chains.goerli]: true,
    [Chains.mumbai]: true,
    [Chains.optimismgoerli]: true,
    [Chains.plumetestnet]: true,
    [Chains.polygonzkevmtestnet]: true,
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

const gasPaymentEnforcement: GasPaymentEnforcementConfig[] = [
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
      tag: 'd1ff3aa-20240226-122224',
    },
    blacklist: [
      ...releaseCandidateHelloworldMatchingList,
      {
        // In an effort to reduce some giant retry queues that resulted
        // from spam txs to the old TestRecipient before we were charging for
        // gas, we blacklist the old TestRecipient address.
        recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
      },
      // OptimismGoerli griefers:
      {
        destinationDomain: getDomainId(chainMetadata.optimismgoerli),
        recipientAddress: [
          '0xed4de02c6f4cb1161bdfefdb2fcdeef4546fa36c',
          '0x723192fc414fe536b414117a4b2c5a7b71f912e3',
          '0x5a48723d80a7ee3be6855ca293059b5287ee6689',
        ],
      },
      // Goerli griefers:
      {
        destinationDomain: getDomainId(chainMetadata.goerli),
        recipientAddress: [
          '0x0461c69ff7f29cfb5efd36b9d377fdfc95418c2b',
          '0xe747c82ed8560ba137b24a3a97ff7504b50c3e91',
          '0x6ad92511ee4a3835bde9b1bfd7063023b56a8c56',
        ],
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
      tag: '6b5b324-20240223-122143',
    },
    chains: validatorChainConfig(Contexts.Hyperlane),
  },
  scraper: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '6b5b324-20240223-122143',
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
      tag: '95fe655-20240222-183959',
    },
    whitelist: [...releaseCandidateHelloworldMatchingList],
    gasPaymentEnforcement,
    transactionGasLimit: 750000,
    // Skipping arbitrum because the gas price estimates are inclusive of L1
    // fees which leads to wildly off predictions.
    skipTransactionGasLimitFor: [chainMetadata.arbitrumgoerli.name],
  },
  validators: {
    rpcConsensusType: RpcConsensusType.Fallback,
    docker: {
      repo,
      tag: '95fe655-20240222-183959',
    },
    chains: validatorChainConfig(Contexts.ReleaseCandidate),
  },
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
