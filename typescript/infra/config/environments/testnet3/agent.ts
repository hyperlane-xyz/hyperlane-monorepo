import { chainMetadata } from '@hyperlane-xyz/sdk';

import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { TestnetChains, chainNames, environment } from './chains';
// import { helloWorld } from './helloworld';
import { validators } from './validators';

/*
const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);
*/

export const hyperlane: AgentConfig<TestnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: 'sha-73128c6',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [],
  },
  connectionType: ConnectionType.HttpQuorum,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 1,
    },
    chainOverrides: {
      alfajores: {
        reorgPeriod: chainMetadata.alfajores.blocks.reorgPeriod,
      },
      fuji: {
        reorgPeriod: chainMetadata.fuji.blocks.reorgPeriod,
      },
      mumbai: {
        reorgPeriod: chainMetadata.mumbai.blocks.reorgPeriod,
      },
      bsctestnet: {
        reorgPeriod: chainMetadata.bsctestnet.blocks.reorgPeriod,
      },
      goerli: {
        reorgPeriod: chainMetadata.goerli.blocks.reorgPeriod,
      },
      moonbasealpha: {
        reorgPeriod: chainMetadata.moonbasealpha.blocks.reorgPeriod,
      },
    },
  },
  relayer: {
    default: {
      // blacklist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
