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

import { chainNames } from './chains';

export const multisigIsms = (
  origin: ChainName,
  type: MultisigIsmConfig['type'],
  isRc: boolean,
): ChainMap<MultisigIsmConfig> =>
  objMap(
    objFilter(
      isRc ? rcMultisigIsmConfigs : defaultMultisigIsmConfigs,
      (chain, config): config is MultisigIsmConfig =>
        chain !== origin && chainNames.includes(chain),
    ),
    (_, config) => ({
      ...config,
      type,
    }),
  );

export const routingIsm = (
  origin: ChainName,
  type: MultisigIsmConfig['type'],
  isRc: boolean,
): RoutingIsmConfig => {
  return {
    type: ModuleType.ROUTING,
    owner: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    domains: multisigIsms(origin, type, isRc),
  };
};

export const aggregationIsm = (
  origin: ChainName,
  isRC = false,
): AggregationIsmConfig => {
  return {
    type: ModuleType.AGGREGATION,
    modules: [
      routingIsm(origin, ModuleType.MESSAGE_ID_MULTISIG, isRC),
      routingIsm(origin, ModuleType.MERKLE_ROOT_MULTISIG, isRC),
    ],
    threshold: 1,
  };
};
