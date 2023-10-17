import {
  AggregationIsmConfig,
  ChainName,
  ModuleType,
} from '@hyperlane-xyz/sdk';

import { Contexts } from './contexts';
import { multisigIsm } from './multisigIsm';

// Merkle Root    Message ID
export const aggregationIsm = (
  remote: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  return {
    type: ModuleType.AGGREGATION,
    modules: [
      // Ordering matters to preserve determinism
      multisigIsm(remote, ModuleType.MERKLE_ROOT_MULTISIG, context),
      multisigIsm(remote, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
};
