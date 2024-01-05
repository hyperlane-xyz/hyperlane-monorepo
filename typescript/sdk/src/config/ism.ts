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

export const routingIsm = (
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
export const aggregationIsm = (
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

// Routing ISM => Aggregation (t/2)
//                 |              |
//                 |              |
//                 v              v
//            Merkle Root    Message ID
export const routingOverAggregation = (
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
          [chain]: aggregationIsm(multisigConfigs[chain], aggregationThreshold),
        }),
        {},
      ),
  };
};
