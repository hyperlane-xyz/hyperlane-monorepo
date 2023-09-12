import { objMap } from '@hyperlane-xyz/utils';

import { MultisigIsmConfig } from '../ism/types';
import { ChainMap } from '../types';

import multisigIsm from './multisigIsm.json';

export const defaultMultisigIsmConfigs: ChainMap<MultisigIsmConfig> = objMap(
  multisigIsm,
  (_chain, config) => ({
    type: config.type,
    threshold: config.threshold,
    validators: config.validators.map((validator) => validator.address),
  }),
);
