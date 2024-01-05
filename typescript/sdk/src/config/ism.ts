import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import {
  AggregationIsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from '../ism/types';
import { ChainMap, ChainName } from '../types';

export const buildMultisigIsmConfig = (
  type: MultisigIsmConfig['type'] = IsmType.MESSAGE_ID_MULTISIG,
  multisigConfig: MultisigConfig,
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
    (_, config) => buildMultisigIsmConfig(type, config),
  );
};

// Routing ---> Multisig
export const buildRoutingIsm = (
  local_chain: string,
  owner: string,
  multisigIsm: ChainMap<MultisigIsmConfig>,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(multisigIsm).filter(([chain]) => chain !== local_chain),
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
  aggregationThreshold = 2,
): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      // Ordering matters to preserve determinism
      buildMultisigIsmConfig(IsmType.MERKLE_ROOT_MULTISIG, multisigConfig),
      buildMultisigIsmConfig(IsmType.MESSAGE_ID_MULTISIG, multisigConfig),
    ],
    threshold: aggregationThreshold,
  };
};

// all chains except local
export const buildAggregationIsmConfigs = (
  local: ChainName,
  chains: ChainName[],
  multisigConfigs: ChainMap<MultisigConfig>,
): ChainMap<AggregationIsmConfig> => {
  return objMap(
    objFilter(
      multisigConfigs,
      (chain, config): config is MultisigConfig =>
        chain !== local && chains.includes(chain),
    ),
    (_, config) => buildAggregationIsmConfig(config),
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
  aggregationThreshold = 2,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner: owners[local],
    domains: Object.keys(owners)
      .filter((chain) => chain !== local)
      .reduce(
        (acc, chain) => ({
          ...acc,
          [chain]: buildAggregationIsmConfig(
            multisigConfigs[chain],
            aggregationThreshold,
          ),
        }),
        {},
      ),
  };
};
