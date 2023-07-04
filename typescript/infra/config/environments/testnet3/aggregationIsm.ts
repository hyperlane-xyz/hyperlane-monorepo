import {
  AggregationIsmConfig,
  ModuleType,
  MultisigIsmConfig,
} from '@hyperlane-xyz/sdk';

export const aggregationIsm = (
  multisigIsmConfig: MultisigIsmConfig,
): AggregationIsmConfig => {
  const merkleRootMultisig: MultisigIsmConfig = {
    ...multisigIsmConfig,
    type: ModuleType.MERKLE_ROOT_MULTISIG,
  };

  const messageIdMultisig: MultisigIsmConfig = {
    ...multisigIsmConfig,
    type: ModuleType.MESSAGE_ID_MULTISIG,
  };

  return {
    type: ModuleType.AGGREGATION,
    modules: [merkleRootMultisig, messageIdMultisig],
    threshold: 1,
  };
};
