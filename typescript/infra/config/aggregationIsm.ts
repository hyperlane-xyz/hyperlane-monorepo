import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
  objFilter,
  objMap,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment } from '../src/config';

import { Contexts } from './contexts';
import { chainNames as mainnet2Chains } from './environments/mainnet2/chains';
import { owners as mainnet2Owners } from './environments/mainnet2/owners';
import { chainNames as testChains } from './environments/test/chains';
import { owners as testOwners } from './environments/test/owners';
import { chainNames as testnet3Chains } from './environments/testnet3/chains';
import { owners as testnet3Owners } from './environments/testnet3/owners';
import { rcMultisigIsmConfigs } from './multisigIsm';

export const chains = {
  mainnet2: mainnet2Chains,
  testnet3: testnet3Chains,
  test: testChains,
};

export const owners = {
  testnet3: testnet3Owners,
  mainnet2: mainnet2Owners,
  test: testOwners,
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

/// Routing => Multisig ISM type
export const routingIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): RoutingIsmConfig => {
  const defaultMultisigIsmConfigs = multisigIsms(
    environment,
    local,
    type,
    context,
  );
  return {
    type: ModuleType.ROUTING,
    domains: defaultMultisigIsmConfigs,
    owner: owners[environment][local],
  };
};

/// 1/2 Aggregation => Routing => Multisig ISM
export const aggregationIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  const config: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [
      // ORDERING MATTERS
      routingIsm(environment, local, ModuleType.MERKLE_ROOT_MULTISIG, context),
      routingIsm(environment, local, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
  return config;
};

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
