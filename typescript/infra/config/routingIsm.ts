import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  IsmConfig,
  IsmType,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment } from '../src/config';

import { aggregationIsm } from './aggregationIsm';
import { Contexts } from './contexts';
import { supportedChainNames as mainnet3Chains } from './environments/mainnet3/chains';
import { owners as mainnet3Owners } from './environments/mainnet3/owners';
import { chainNames as testChains } from './environments/test/chains';
import { owners as testOwners } from './environments/test/owners';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/chains';
import { owners as testnet4Owners } from './environments/testnet4/owners';

const chains = {
  mainnet3: mainnet3Chains,
  testnet4: testnet4Chains,
  test: testChains,
};

const owners = {
  testnet4: testnet4Owners,
  mainnet3: mainnet3Owners,
  test: testOwners,
};

// Intended to be the "entrypoint" ISM.
// Routing ISM => Aggregation (1/2)
//                 |              |
//                 |              |
//                 v              v
//            Merkle Root    Message ID
export const routingIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  context: Contexts,
): RoutingIsmConfig | string => {
  const aggregationIsms: ChainMap<AggregationIsmConfig> = chains[environment]
    .filter((_) => _ !== local)
    .reduce(
      (acc, chain) => ({
        ...acc,
        [chain]: aggregationIsm(chain, context),
      }),
      {},
    );

  return {
    type: IsmType.ROUTING,
    domains: aggregationIsms,
    owner: owners[environment][local],
  };
};

const replacerEnum = (key: string, value: any) => {
  if (key === 'type') {
    switch (value) {
      case IsmType.AGGREGATION:
        return 'AGGREGATION';
      case IsmType.ROUTING:
        return 'ROUTING';
      case IsmType.MERKLE_ROOT_MULTISIG:
        return 'MERKLE_ROOT_MULTISIG';
      case IsmType.MESSAGE_ID_MULTISIG:
        return 'MESSAGE_ID_MULTISIG';
      default:
        return value;
    }
  }
  return value;
};

export const printIsmConfig = (ism: IsmConfig): string => {
  return JSON.stringify(ism, replacerEnum, 2);
};
