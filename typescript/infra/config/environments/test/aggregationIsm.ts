import { AggregationIsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import { merkleRootMultisig, messageIdMultisig } from './multisigIsm.js';

export const aggregationIsm = (validatorKey: string): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      merkleRootMultisig(validatorKey),
      messageIdMultisig(validatorKey),
    ],
    threshold: 1,
  };
};
