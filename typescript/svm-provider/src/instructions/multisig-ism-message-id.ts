import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';

import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { ByteCursor, concatBytes, option, u8 } from '../codecs/binary.js';
import {
  decodeDomainedValidatorsAndThreshold,
  decodeValidatorsAndThreshold,
  encodeDomainedValidatorsAndThreshold,
  type Domained,
  type H160,
  type ValidatorsAndThreshold,
} from '../codecs/shared.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
} from './utils.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';

export enum MultisigIsmMessageIdProgramInstructionKind {
  Initialize = 0,
  SetValidatorsAndThreshold = 1,
  GetOwner = 2,
  TransferOwnership = 3,
}

export type MultisigIsmMessageIdProgramInstruction =
  | { kind: 'initialize' }
  | {
      kind: 'setValidatorsAndThreshold';
      value: Domained<ValidatorsAndThreshold>;
    }
  | { kind: 'getOwner' }
  | { kind: 'transferOwnership'; newOwner: Uint8Array | null };

export function encodeMultisigIsmMessageIdProgramInstruction(
  instruction: MultisigIsmMessageIdProgramInstruction,
): ReadonlyUint8Array {
  switch (instruction.kind) {
    case 'initialize':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.Initialize),
      );
    case 'setValidatorsAndThreshold':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(
          MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
        ),
        encodeDomainedValidatorsAndThreshold(instruction.value),
      );
    case 'getOwner':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.GetOwner),
      );
    case 'transferOwnership':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.TransferOwnership),
        option(instruction.newOwner, (owner) => owner),
      );
  }
}

export function decodeMultisigIsmMessageIdProgramInstruction(
  data: Uint8Array,
): MultisigIsmMessageIdProgramInstruction | null {
  if (data.length < 9) return null;
  const cursor = new ByteCursor(data);
  const discriminator = cursor.readBytes(8);
  if (!discriminator.every((value) => value === 1)) return null;

  const kind = cursor.readU8();
  switch (kind) {
    case MultisigIsmMessageIdProgramInstructionKind.Initialize:
      return { kind: 'initialize' };
    case MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold:
      return {
        kind: 'setValidatorsAndThreshold',
        value: decodeDomainedValidatorsAndThreshold(cursor),
      };
    case MultisigIsmMessageIdProgramInstructionKind.GetOwner:
      return { kind: 'getOwner' };
    case MultisigIsmMessageIdProgramInstructionKind.TransferOwnership: {
      const hasOwner = cursor.readU8() === 1;
      return {
        kind: 'transferOwnership',
        newOwner: hasOwner ? cursor.readBytes(32) : null,
      };
    }
    default:
      return null;
  }
}

export interface SetDomainValidatorsArgs {
  programAddress: Address;
  owner: TransactionSigner;
  domain: number;
  validators: (H160 | string)[];
  threshold: number;
}

export async function getInitializeMultisigIsmMessageIdInstruction(
  programAddress: Address,
  owner: TransactionSigner,
): Promise<Instruction> {
  const { address: accessControl } =
    await deriveMultisigIsmAccessControlPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      writableSigner(owner),
      writableAccount(accessControl),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeMultisigIsmMessageIdProgramInstruction({ kind: 'initialize' }),
  );
}

export async function getSetValidatorsAndThresholdInstruction(
  args: SetDomainValidatorsArgs,
): Promise<Instruction> {
  const { address: accessControl } = await deriveMultisigIsmAccessControlPda(
    args.programAddress,
  );
  const { address: domainData } = await deriveMultisigIsmDomainDataPda(
    args.programAddress,
    args.domain,
  );
  const validators = args.validators.map((v) =>
    typeof v === 'string' ? hexToBytes20(v) : v,
  );
  return buildInstruction(
    args.programAddress,
    [
      writableSigner(args.owner),
      readonlyAccount(accessControl),
      writableAccount(domainData),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeMultisigIsmMessageIdProgramInstruction({
      kind: 'setValidatorsAndThreshold',
      value: {
        domain: args.domain,
        data: {
          validators,
          threshold: args.threshold,
        },
      },
    }),
  );
}

export async function getTransferOwnershipInstruction(
  programAddress: Address,
  owner: TransactionSigner,
  newOwner: Uint8Array | null,
): Promise<Instruction> {
  const { address: accessControl } =
    await deriveMultisigIsmAccessControlPda(programAddress);
  return buildInstruction(
    programAddress,
    [writableSigner(owner), writableAccount(accessControl)],
    encodeMultisigIsmMessageIdProgramInstruction({
      kind: 'transferOwnership',
      newOwner,
    }),
  );
}

function hexToBytes20(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length !== 40) {
    throw new Error(`Expected 20-byte hex validator, got ${value}`);
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function _decodeValidatorsOnlyForTests(
  data: Uint8Array,
): ValidatorsAndThreshold {
  return decodeValidatorsAndThreshold(new ByteCursor(data));
}
