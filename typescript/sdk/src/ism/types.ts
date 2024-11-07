import { z } from 'zod';

import {
  ArbL2ToL1Ism,
  IAggregationIsm,
  IInterchainSecurityModule,
  IMultisigIsm,
  IRoutingIsm,
  IStaticWeightedMultisigIsm,
  OPStackIsm,
  PausableIsm,
  TestIsm,
  TrustedRelayerIsm,
} from '@hyperlane-xyz/core';
import type { Address, Domain, ValueOf } from '@hyperlane-xyz/utils';

import { OwnableConfig } from '../deploy/types.js';
import { ChainMap } from '../types.js';

import {
  ArbL2ToL1IsmConfigSchema,
  IsmConfigSchema,
  MultisigIsmConfigSchema,
  OpStackIsmConfigSchema,
  PausableIsmConfigSchema,
  TestIsmConfigSchema,
  TrustedRelayerIsmConfigSchema,
  WeightedMultisigIsmConfigSchema,
} from './schemas.js';

// this enum should match the IInterchainSecurityModule.sol enum
// meant for the relayer
export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG, // DEPRECATED
  MERKLE_ROOT_MULTISIG,
  MESSAGE_ID_MULTISIG,
  NULL,
  CCIP_READ,
  ARB_L2_TO_L1,
  WEIGHTED_MERKLE_ROOT_MULTISIG,
  WEIGHTED_MESSAGE_ID_MULTISIG,
}

// this enum can be adjusted as per deployments necessary
// meant for the deployer and checker
export enum IsmType {
  CUSTOM = 'custom',
  OP_STACK = 'opStackIsm',
  ROUTING = 'domainRoutingIsm',
  FALLBACK_ROUTING = 'defaultFallbackRoutingIsm',
  AGGREGATION = 'staticAggregationIsm',
  STORAGE_AGGREGATION = 'storageAggregationIsm',
  MERKLE_ROOT_MULTISIG = 'merkleRootMultisigIsm',
  MESSAGE_ID_MULTISIG = 'messageIdMultisigIsm',
  STORAGE_MERKLE_ROOT_MULTISIG = 'storageMerkleRootMultisigIsm',
  STORAGE_MESSAGE_ID_MULTISIG = 'storageMessageIdMultisigIsm',
  TEST_ISM = 'testIsm',
  PAUSABLE = 'pausableIsm',
  TRUSTED_RELAYER = 'trustedRelayerIsm',
  ARB_L2_TO_L1 = 'arbL2ToL1Ism',
  WEIGHTED_MERKLE_ROOT_MULTISIG = 'weightedMerkleRootMultisigIsm',
  WEIGHTED_MESSAGE_ID_MULTISIG = 'weightedMessageIdMultisigIsm',
}

// ISM types that can be updated in-place
export const MUTABLE_ISM_TYPE = [
  IsmType.ROUTING,
  IsmType.FALLBACK_ROUTING,
  IsmType.PAUSABLE,
];

// mapping between the two enums
export function ismTypeToModuleType(ismType: IsmType): ModuleType {
  switch (ismType) {
    case IsmType.ROUTING:
      return ModuleType.ROUTING;
    case IsmType.FALLBACK_ROUTING:
      return ModuleType.ROUTING;
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return ModuleType.AGGREGATION;
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
      return ModuleType.MERKLE_ROOT_MULTISIG;
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
      return ModuleType.MESSAGE_ID_MULTISIG;
    case IsmType.OP_STACK:
    case IsmType.TEST_ISM:
    case IsmType.PAUSABLE:
    case IsmType.CUSTOM:
    case IsmType.TRUSTED_RELAYER:
      return ModuleType.NULL;
    case IsmType.ARB_L2_TO_L1:
      return ModuleType.ARB_L2_TO_L1;
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
      return ModuleType.WEIGHTED_MERKLE_ROOT_MULTISIG;
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
      return ModuleType.WEIGHTED_MESSAGE_ID_MULTISIG;
  }
}

export type MultisigConfig = {
  validators: Array<Address>;
  threshold: number;
};

export type MultisigIsmConfig = z.infer<typeof MultisigIsmConfigSchema>;
export type WeightedMultisigIsmConfig = z.infer<
  typeof WeightedMultisigIsmConfigSchema
>;
export type TestIsmConfig = z.infer<typeof TestIsmConfigSchema>;
export type PausableIsmConfig = z.infer<typeof PausableIsmConfigSchema>;
export type OpStackIsmConfig = z.infer<typeof OpStackIsmConfigSchema>;
export type TrustedRelayerIsmConfig = z.infer<
  typeof TrustedRelayerIsmConfigSchema
>;
export type ArbL2ToL1IsmConfig = z.infer<typeof ArbL2ToL1IsmConfigSchema>;

export type NullIsmConfig =
  | TestIsmConfig
  | PausableIsmConfig
  | OpStackIsmConfig
  | TrustedRelayerIsmConfig;

export type RoutingIsmConfig = OwnableConfig & {
  type: IsmType.ROUTING | IsmType.FALLBACK_ROUTING;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: IsmType.AGGREGATION | IsmType.STORAGE_AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type IsmConfig = z.infer<typeof IsmConfigSchema>;

export type DeployedIsmType = {
  [IsmType.CUSTOM]: IInterchainSecurityModule;
  [IsmType.ROUTING]: IRoutingIsm;
  [IsmType.FALLBACK_ROUTING]: IRoutingIsm;
  [IsmType.AGGREGATION]: IAggregationIsm;
  [IsmType.STORAGE_AGGREGATION]: IAggregationIsm;
  [IsmType.MERKLE_ROOT_MULTISIG]: IMultisigIsm;
  [IsmType.MESSAGE_ID_MULTISIG]: IMultisigIsm;
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]: IMultisigIsm;
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]: IMultisigIsm;
  [IsmType.OP_STACK]: OPStackIsm;
  [IsmType.TEST_ISM]: TestIsm;
  [IsmType.PAUSABLE]: PausableIsm;
  [IsmType.TRUSTED_RELAYER]: TrustedRelayerIsm;
  [IsmType.ARB_L2_TO_L1]: ArbL2ToL1Ism;
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]: IStaticWeightedMultisigIsm;
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]: IStaticWeightedMultisigIsm;
};

export type DeployedIsm = ValueOf<DeployedIsmType>;

// for finding the difference between the onchain deployment and the config provided
export type RoutingIsmDelta = {
  domainsToUnenroll: Domain[]; // new or updated isms for the domain
  domainsToEnroll: Domain[]; // isms to remove
  owner?: Address; // is the owner different
  mailbox?: Address; // is the mailbox different (only for fallback routing)
};
