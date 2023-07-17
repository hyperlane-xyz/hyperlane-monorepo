import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
  objFilter,
  objMap,
  rcMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../contexts';

import { chainNames } from './chains';
import { owners } from './owners';

export const multisigIsms = (
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
        chain !== local && chainNames.includes(chain),
    ),
    (_, config) => ({
      ...config,
      type,
    }),
  );

/// Routing => Multisig ISM type
export const routingIsm = (
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): RoutingIsmConfig => {
  const multisigIsmConfigs = multisigIsms(local, type, context);
  return {
    type: ModuleType.ROUTING,
    domains: multisigIsmConfigs,
    owner: owners[local],
  };
};

/// 1/2 Aggregation => Routing => Multisig ISM
export const aggregationIsm = (
  local: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  return {
    type: ModuleType.AGGREGATION,
    modules: [
      // ORDERING MATTERS
      routingIsm(local, ModuleType.MERKLE_ROOT_MULTISIG, context),
      routingIsm(local, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
};
