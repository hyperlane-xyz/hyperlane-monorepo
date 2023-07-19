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

import { Contexts } from './contexts';
import { environments } from './environments';
import { chainNames as mainnetChainNames } from './environments/mainnet2/chains';
import { owners as mainnetOwners } from './environments/mainnet2/owners';
import { chainNames as testnetChainNames } from './environments/testnet3/chains';
import { owners as testnetOwners } from './environments/testnet3/owners';
import { rcMultisigIsmConfigs } from './multisigIsm';

export type DeployEnvironment = keyof typeof environments;

const chainsInclude = (
  environment: DeployEnvironment,
  chain: ChainName,
): boolean => {
  if (environment === 'mainnet2') return mainnetChainNames.includes(chain);
  else if (environment === 'testnet3') return testnetChainNames.includes(chain);
  else
    throw new Error(`Unknown environment for AggregationISM: ${environment}`);
};

export const multisigIsms = (
  environment: DeployEnvironment,
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
        chain !== local && chainsInclude(environment, chain),
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
    owner:
      environment === 'mainnet2' ? mainnetOwners[local] : testnetOwners[local],
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
