import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../types';

import { MultisigConfig, MultisigIsmConfig } from './types';

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
