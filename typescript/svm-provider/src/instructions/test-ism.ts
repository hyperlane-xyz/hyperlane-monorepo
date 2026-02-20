import type { Address, Instruction, TransactionSigner } from '@solana/kit';

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { ByteCursor, concatBytes, u8 } from '../codecs/binary.js';
import { deriveTestIsmStoragePda } from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
} from './utils.js';

export enum TestIsmInstructionKind {
  Init = 0,
  SetAccept = 1,
}

export type TestIsmProgramInstruction =
  | { kind: 'init' }
  | { kind: 'setAccept'; accept: boolean };

export function encodeTestIsmProgramInstruction(
  instruction: TestIsmProgramInstruction,
): Uint8Array {
  switch (instruction.kind) {
    case 'init':
      return u8(TestIsmInstructionKind.Init);
    case 'setAccept':
      return concatBytes(
        u8(TestIsmInstructionKind.SetAccept),
        u8(instruction.accept ? 1 : 0),
      );
  }
}

export function decodeTestIsmProgramInstruction(
  data: Uint8Array,
): TestIsmProgramInstruction | null {
  if (data.length < 1) return null;
  const cursor = new ByteCursor(data);
  const kind = cursor.readU8();
  switch (kind) {
    case TestIsmInstructionKind.Init:
      return { kind: 'init' };
    case TestIsmInstructionKind.SetAccept:
      return { kind: 'setAccept', accept: cursor.readBool() };
    default:
      return null;
  }
}

export async function getInitTestIsmInstruction(
  programAddress: Address,
  payer: TransactionSigner,
): Promise<Instruction> {
  const { address: storage } = await deriveTestIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSigner(payer),
      writableAccount(storage),
    ],
    encodeTestIsmProgramInstruction({ kind: 'init' }),
  );
}

export async function getSetAcceptTestIsmInstruction(
  programAddress: Address,
  accept: boolean,
): Promise<Instruction> {
  const { address: storage } = await deriveTestIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [writableAccount(storage)],
    encodeTestIsmProgramInstruction({ kind: 'setAccept', accept }),
  );
}
