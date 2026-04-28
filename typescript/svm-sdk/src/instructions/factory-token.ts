import type { Address, Instruction, TransactionSigner } from '@solana/kit';

import { concatBytes, u8, vec } from '../codecs/binary.js';
import {
  encodeGasRouterConfig,
  encodeRemoteRouterConfig,
  type GasRouterConfig,
  type RemoteRouterConfig,
} from '../codecs/shared.js';
import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  deriveFactoryStatePda,
  deriveMailboxDispatchAuthorityPda,
  deriveRoutePda,
} from '../pda.js';
import { encodeTokenInit, type TokenInitInstructionData } from './token.js';
import {
  buildInstruction,
  type InstructionAccountMeta,
  readonlyAccount,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from './utils.js';

export const FactoryInstructionKind = {
  InitFactory: 8,
  CreateRoute: 9,
  EnrollRemoteRoutersForRoute: 10,
  SetDestinationGasConfigsForRoute: 11,
  SetInterchainSecurityModuleForRoute: 12,
  SetInterchainGasPaymasterForRoute: 13,
  TransferOwnershipForRoute: 14,
} as const;

export interface CreateRouteInstructionData extends TokenInitInstructionData {
  salt: Uint8Array;
}

export async function getCreateRouteInstruction(
  factoryProgramAddress: Address,
  payer: TransactionSigner,
  data: CreateRouteInstructionData,
  pluginAccounts: InstructionAccountMeta[],
): Promise<Instruction> {
  const { address: factoryStatePda } = await deriveFactoryStatePda(
    factoryProgramAddress,
  );
  const { address: routePda } = await deriveRoutePda(
    factoryProgramAddress,
    data.salt,
  );
  const { address: dispatchAuthority } =
    await deriveMailboxDispatchAuthorityPda(factoryProgramAddress);

  return buildInstruction(
    factoryProgramAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(factoryStatePda),
      writableAccount(routePda),
      writableAccount(dispatchAuthority),
      writableSigner(payer),
      ...pluginAccounts,
    ],
    concatBytes(
      PROGRAM_INSTRUCTION_DISCRIMINATOR,
      u8(FactoryInstructionKind.CreateRoute),
      data.salt,
      encodeTokenInit(data),
    ),
  );
}

export async function getEnrollRemoteRoutersForRouteInstruction(
  factoryProgramAddress: Address,
  ownerAddress: Address,
  salt: Uint8Array,
  routers: RemoteRouterConfig[],
  lookupPdas: Address[],
): Promise<Instruction> {
  const { address: routePda } = await deriveRoutePda(
    factoryProgramAddress,
    salt,
  );
  return buildInstruction(
    factoryProgramAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(routePda),
      writableSignerAddress(ownerAddress),
      ...lookupPdas.map((pda) => writableAccount(pda)),
    ],
    concatBytes(
      PROGRAM_INSTRUCTION_DISCRIMINATOR,
      u8(FactoryInstructionKind.EnrollRemoteRoutersForRoute),
      salt,
      vec(routers, encodeRemoteRouterConfig),
    ),
  );
}

export async function getSetDestinationGasConfigsForRouteInstruction(
  factoryProgramAddress: Address,
  ownerAddress: Address,
  salt: Uint8Array,
  gasConfigs: GasRouterConfig[],
): Promise<Instruction> {
  const { address: routePda } = await deriveRoutePda(
    factoryProgramAddress,
    salt,
  );
  return buildInstruction(
    factoryProgramAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(routePda),
      writableSignerAddress(ownerAddress),
    ],
    concatBytes(
      PROGRAM_INSTRUCTION_DISCRIMINATOR,
      u8(FactoryInstructionKind.SetDestinationGasConfigsForRoute),
      salt,
      vec(gasConfigs, encodeGasRouterConfig),
    ),
  );
}
