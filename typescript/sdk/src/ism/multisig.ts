import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../types.js';

import {
  AggregationIsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
} from './types.js';

// Convert a MultisigConfig to a MultisigIsmConfig with the specified ISM type
export const multisigConfigToIsmConfig = (
  type: MultisigIsmConfig['type'],
  config: MultisigConfig,
): MultisigIsmConfig => ({
  type,
  threshold: config?.threshold || 0,
  validators: config?.validators.map((v) => v.address) || [],
});

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
      (chain, _): _ is MultisigConfig =>
        chain !== local && chains.includes(chain),
    ),
    (_, config) => multisigConfigToIsmConfig(type, config),
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
    (_, config): AggregationIsmConfig => ({
      type: IsmType.AGGREGATION,
      modules: [
        multisigConfigToIsmConfig(IsmType.MESSAGE_ID_MULTISIG, config),
        multisigConfigToIsmConfig(IsmType.MERKLE_ROOT_MULTISIG, config),
      ],
      threshold: 1,
    }),
  );
};
