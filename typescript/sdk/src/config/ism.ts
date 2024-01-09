import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from '../ism/types';
import { ChainMap, ChainName } from '../types';

export const buildMultisigIsmConfig = (
  multisigConfig: MultisigConfig,
  type: MultisigIsmConfig['type'] = IsmType.MESSAGE_ID_MULTISIG,
): MultisigIsmConfig => {
  return {
    type,
    ...multisigConfig,
  };
};

export const buildMultisigIsmConfigs = (
  type: MultisigIsmConfig['type'],
  local: ChainName,
  chains: ChainName[],
  multisigConfigs: ChainMap<MultisigConfig>,
): ChainMap<MultisigIsmConfig> => {
  return objMap(
    objFilter(
      multisigConfigs,
      (chain, config): config is MultisigConfig =>
        chain !== local && chains.includes(chain),
    ),
    (_, config) => buildMultisigIsmConfig(config, type),
  );
};

// Routing ---> Multisig
export const buildRoutingIsm = (
  local_chain: string,
  owner: string,
  ism: ChainMap<IsmConfig>,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(ism).filter(([chain]) => chain !== local_chain),
    ),
  };
};

// Aggregation (t/2)
// |              |
// |              |
// v              v
// Merkle Root    Message ID
export const buildAggregationIsmConfig = (
  multisigConfig: MultisigConfig,
  aggregationThreshold = 1,
): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      // Ordering matters to preserve determinism
      buildMultisigIsmConfig(multisigConfig, IsmType.MERKLE_ROOT_MULTISIG),
      buildMultisigIsmConfig(multisigConfig, IsmType.MESSAGE_ID_MULTISIG),
    ],
    threshold: aggregationThreshold,
  };
};

// all chains except local
export const buildAggregationIsmConfigs = (
  local: ChainName,
  chains: ChainName[],
  multisigConfigs: ChainMap<MultisigConfig>,
  aggregationThreshold = 1,
): ChainMap<AggregationIsmConfig> => {
  return objMap(multisigConfigs, (_, config) =>
    buildAggregationIsmConfig(config, aggregationThreshold),
  ) as ChainMap<AggregationIsmConfig>;
};

// Routing ISM => Aggregation (t/2)
//                 |              |
//                 |              |
//                 v              v
//            Merkle Root    Message ID
export const buildRoutingOverAggregationIsmConfig = (
  local: ChainName,
  owners: ChainMap<Address>,
  multisigConfigs: ChainMap<MultisigConfig>,
  aggregationThreshold = 1,
): RoutingIsmConfig => {
  return buildRoutingIsm(
    local,
    owners[local],
    buildAggregationIsmConfigs(
      local,
      Object.keys(owners),
      multisigConfigs,
      aggregationThreshold,
    ),
  );
};
