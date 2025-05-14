import { ContractType, StarknetContracts } from '@hyperlane-xyz/starknet-core';

import { IsmType, SupportedIsmTypesOnStarknetType } from './types.js';

export const SupportedIsmTypesOnStarknet = [
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.TRUSTED_RELAYER,
  IsmType.ROUTING,
  IsmType.PAUSABLE,
  IsmType.AGGREGATION,
  IsmType.FALLBACK_ROUTING,
] as const satisfies readonly IsmType[];

export const StarknetIsmContractName: Record<
  SupportedIsmTypesOnStarknetType,
  keyof StarknetContracts[ContractType.CONTRACT]
> = {
  [IsmType.MESSAGE_ID_MULTISIG]: 'messageid_multisig_ism',
  [IsmType.MERKLE_ROOT_MULTISIG]: 'merkleroot_multisig_ism',
  [IsmType.TRUSTED_RELAYER]: 'trusted_relayer_ism',
  [IsmType.ROUTING]: 'domain_routing_ism',
  [IsmType.PAUSABLE]: 'pausable_ism',
  [IsmType.AGGREGATION]: 'aggregation',
  [IsmType.FALLBACK_ROUTING]: 'default_fallback_routing_ism',
};
