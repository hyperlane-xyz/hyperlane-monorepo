import {
  ArbL2ToL1Ism__factory,
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm__factory,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAggregationIsm__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMerkleRootWeightedMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticMessageIdWeightedMultisigIsmFactory__factory,
  StorageAggregationIsm__factory,
  StorageMerkleRootMultisigIsm__factory,
  StorageMessageIdMultisigIsm__factory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';

import { IsmType } from './types.js';

export const ismContracts = {
  [IsmType.CUSTOM]: 'CustomIsm',
  [IsmType.OP_STACK]: 'OPStackIsm',
  [IsmType.ROUTING]: 'DomainRoutingIsm',
  [IsmType.FALLBACK_ROUTING]: 'DefaultFallbackRoutingIsm',
  [IsmType.AGGREGATION]: 'StaticAggregationIsm',
  [IsmType.STORAGE_AGGREGATION]: 'StorageAggregationIsm',
  [IsmType.MERKLE_ROOT_MULTISIG]: 'MerkleRootMultisigIsm',
  [IsmType.MESSAGE_ID_MULTISIG]: 'MessageIdMultisigIsm',
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]: 'StorageMerkleRootMultisigIsm',
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]: 'StorageMessageIdMultisigIsm',
  [IsmType.TEST_ISM]: 'TestIsm',
  [IsmType.PAUSABLE]: 'PausableIsm',
  [IsmType.TRUSTED_RELAYER]: 'TrustedRelayerIsm',
  [IsmType.ARB_L2_TO_L1]: 'ArbL2ToL1Ism',
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]: 'WeightedMerkleRootMultisigIsm',
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]: 'WeightedMessageIdMultisigIsm',
};

export const ismFactories = {
  [IsmType.OP_STACK]: new OPStackIsm__factory(),
  [IsmType.ROUTING]: new DomainRoutingIsm__factory(),
  [IsmType.FALLBACK_ROUTING]: new DefaultFallbackRoutingIsm__factory(),
  [IsmType.AGGREGATION]: new StaticAggregationIsm__factory(),
  [IsmType.STORAGE_AGGREGATION]: new StorageAggregationIsm__factory(),
  [IsmType.MERKLE_ROOT_MULTISIG]:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  [IsmType.MESSAGE_ID_MULTISIG]:
    new StaticMessageIdMultisigIsmFactory__factory(),
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]:
    new StorageMerkleRootMultisigIsm__factory(),
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]:
    new StorageMessageIdMultisigIsm__factory(),
  [IsmType.TEST_ISM]: new TestIsm__factory(),
  [IsmType.PAUSABLE]: new PausableIsm__factory(),
  [IsmType.TRUSTED_RELAYER]: new TrustedRelayerIsm__factory(),
  [IsmType.ARB_L2_TO_L1]: new ArbL2ToL1Ism__factory(),
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]:
    new StaticMerkleRootWeightedMultisigIsmFactory__factory(),
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]:
    new StaticMessageIdWeightedMultisigIsmFactory__factory(),
};
