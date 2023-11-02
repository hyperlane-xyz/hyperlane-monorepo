import { AggregationIsmConfig, ChainName } from '@hyperlane-xyz/sdk';
import { IsmType } from '@hyperlane-xyz/sdk/dist/ism/types';

import { Contexts } from './contexts';
import { multisigIsm } from './multisigIsm';

// Merkle Root    Message ID
export const aggregationIsm = (
  remote: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      // Ordering matters to preserve determinism
      multisigIsm(remote, IsmType.MERKLE_ROOT_MULTISIG, context),
      multisigIsm(remote, IsmType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
};
