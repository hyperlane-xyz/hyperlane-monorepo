import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';

import { concatBytes, u8, u32le, vec } from '../codecs/binary.js';
import {
  encodeH256,
  encodeRemoteRouterConfig,
  type H256,
  type RemoteRouterConfig,
} from '../codecs/shared.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveCrossCollateralDispatchAuthorityPda,
  deriveCrossCollateralStatePda,
  deriveHyperlaneTokenPda,
} from '../pda.js';
import {
  getTokenInitInstruction,
  type TokenInitInstructionData,
} from './token.js';
import {
  buildInstruction,
  type InstructionAccountMeta,
  readonlyAccount,
  writableAccount,
  writableSignerAddress,
} from './utils.js';

const CC_INSTRUCTION_DISCRIMINATOR = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);

export enum CrossCollateralInstructionKind {
  SetCrossCollateralRouters = 0,
  TransferRemoteTo = 1,
  HandleLocal = 2,
  HandleLocalAccountMetas = 3,
}

export type CrossCollateralRouterUpdate =
  | { kind: 'add'; domain: number; router: H256 }
  | { kind: 'remove'; config: RemoteRouterConfig };

function encodeCrossCollateralRouterUpdate(
  update: CrossCollateralRouterUpdate,
): ReadonlyUint8Array {
  if (update.kind === 'add') {
    return concatBytes(u8(0), u32le(update.domain), encodeH256(update.router));
  }

  return concatBytes(u8(1), encodeRemoteRouterConfig(update.config));
}

export async function getCrossCollateralInitInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  init: TokenInitInstructionData,
  pluginAccounts: InstructionAccountMeta[],
  mailboxOutboxPda: Address,
): Promise<Instruction> {
  const { address: ccStatePda } =
    await deriveCrossCollateralStatePda(programAddress);
  const { address: ccDispatchAuthority } =
    await deriveCrossCollateralDispatchAuthorityPda(programAddress);

  return getTokenInitInstruction(programAddress, payer, init, [
    ...pluginAccounts,
    writableAccount(ccStatePda),
    writableAccount(ccDispatchAuthority),
    readonlyAccount(mailboxOutboxPda),
  ]);
}

export async function getSetCrossCollateralRoutersInstruction(
  programAddress: Address,
  owner: Address,
  updates: CrossCollateralRouterUpdate[],
): Promise<Instruction> {
  const { address: ccStatePda } =
    await deriveCrossCollateralStatePda(programAddress);
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);

  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(ccStatePda),
      readonlyAccount(tokenPda),
      writableSignerAddress(owner),
    ],
    concatBytes(
      CC_INSTRUCTION_DISCRIMINATOR,
      u8(CrossCollateralInstructionKind.SetCrossCollateralRouters),
      vec(updates, encodeCrossCollateralRouterUpdate),
    ),
  );
}
