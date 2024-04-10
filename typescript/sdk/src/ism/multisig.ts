import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../types.js';

import {
  AggregationIsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
} from './types.js';

// build multisigIsmConfig from multisigConfig
// eg. for { sepolia (local), arbitrumsepolia, scrollsepolia }
// arbitrumsepolia => Ism, scrollsepolia => Ism
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
    (_, config) => ({
      ...config,
      type,
    }),
  );
};

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
    (_, config) => ({
      type: IsmType.AGGREGATION,
      modules: [
        {
          ...config,
          type: IsmType.MESSAGE_ID_MULTISIG,
        },
        {
          ...config,
          type: IsmType.MERKLE_ROOT_MULTISIG,
        },
      ],
      threshold: 1,
    }),
  ) as ChainMap<AggregationIsmConfig>;
};
