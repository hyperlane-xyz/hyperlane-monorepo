import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  Chains,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  arrayToObject,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../src/config';

import { Contexts } from './contexts';
import { supportedChainNames as mainnet2Chains } from './environments/mainnet2/chains';
import { owners as mainnet2Owners } from './environments/mainnet2/owners';
import { chainNames as testChains } from './environments/test/chains';
import { owners as testOwners } from './environments/test/owners';
import { supportedChainNames as testnet3Chains } from './environments/testnet3/chains';
import { owners as testnet3Owners } from './environments/testnet3/owners';
import { rcMultisigIsmConfigs } from './multisigIsm';

const chains = {
  mainnet2: mainnet2Chains,
  testnet3: testnet3Chains,
  test: testChains,
};

const owners = {
  testnet3: testnet3Owners,
  mainnet2: mainnet2Owners,
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
): RoutingIsmConfig => {
  const aggregationIsms: ChainMap<AggregationIsmConfig> = chains[
    environment
  ].reduce(
    (acc, chain) => ({
      ...acc,
      [chain]: aggregationIsm(chain, context),
    }),
    {},
  );

  return {
    type: ModuleType.ROUTING,
    domains: aggregationIsms,
    owner: owners[environment][local],
  };
};

// Aggregation (1/2)
// |              |
// |              |
// v              v
// Merkle Root    Message ID
export const aggregationIsm = (
  remote: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  return {
    type: ModuleType.AGGREGATION,
    modules: [
      // Ordering matters to preserve determinism
      multisigIsm(remote, ModuleType.MERKLE_ROOT_MULTISIG, context),
      multisigIsm(remote, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
};

export const multisigIsm = (
  remote: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): MultisigIsmConfig => {
  const configs =
    context === Contexts.ReleaseCandidate
      ? rcMultisigIsmConfigs
      : defaultMultisigIsmConfigs;

  return {
    ...configs[remote],
    type,
  };
};

export const multisigIsms = (
  env: DeployEnvironment,
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): ChainMap<MultisigIsmConfig> =>
  objMap(
    objFilter(
      context === Contexts.ReleaseCandidate
        ? rcMultisigIsmConfigs
        : defaultMultisigIsmConfigs,
      (chain, config): config is MultisigIsmConfig =>
        chain !== local && chains[env].includes(chain),
    ),
    (_, config) => ({
      ...config,
      type,
    }),
  );

const replacerEnum = (key: string, value: any) => {
  if (key === 'type') {
    switch (value) {
      case ModuleType.AGGREGATION:
        return 'AGGREGATION';
      case ModuleType.ROUTING:
        return 'ROUTING';
      case ModuleType.MERKLE_ROOT_MULTISIG:
        return 'MERKLE_ROOT_MULTISIG';
      case ModuleType.LEGACY_MULTISIG:
        return 'LEGACY_MULTISIG';
      case ModuleType.MESSAGE_ID_MULTISIG:
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
