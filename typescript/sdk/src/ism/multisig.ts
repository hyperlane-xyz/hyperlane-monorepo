import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../types';

import { AggregationIsmConfig, IsmType, MultisigConfig } from './types';

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
