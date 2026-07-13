import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getAddressCodec } from '@solana/kit';

import {
  deriveCompositeIsmDomainPda,
  deriveCompositeIsmStoragePda,
  deriveProgramDataAddress,
} from '../pda.js';
import { encodeIsmNode, type IsmNode } from '../accounts/composite-ism.js';
import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { concatBytes, option, u32le, u8 } from '../codecs/binary.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
} from './utils.js';

const ADDRESS_CODEC = getAddressCodec();

/**
 * Discriminants for `Instruction` (composite-ism/src/instruction.rs). Order is
 * load-bearing — Borsh encodes enum variants as a u8 index matching Rust
 * declaration order.
 */
export enum CompositeIsmInstructionKind {
  Initialize = 0,
  UpdateConfig = 1,
  GetOwner = 2,
  TransferOwnership = 3,
  SetDomainIsm = 4,
  RemoveDomainIsm = 5,
  Pause = 6,
  Unpause = 7,
}

function encodeInstructionData(
  kind: CompositeIsmInstructionKind,
  body: ArrayLike<number>,
) {
  return concatBytes(PROGRAM_INSTRUCTION_DISCRIMINATOR, u8(kind), body);
}

export async function getInitializeCompositeIsmInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  root: IsmNode,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  const programDataAddress = await deriveProgramDataAddress(programAddress);
  return buildInstruction(
    programAddress,
    [
      writableSigner(payer),
      writableAccount(storagePda),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(programDataAddress),
    ],
    encodeInstructionData(
      CompositeIsmInstructionKind.Initialize,
      encodeIsmNode(root),
    ),
  );
}

export async function getUpdateCompositeIsmConfigInstruction(
  programAddress: Address,
  owner: TransactionSigner,
  root: IsmNode,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [
      writableSigner(owner),
      writableAccount(storagePda),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeInstructionData(
      CompositeIsmInstructionKind.UpdateConfig,
      encodeIsmNode(root),
    ),
  );
}

export async function getTransferCompositeIsmOwnershipInstruction(
  programAddress: Address,
  owner: TransactionSigner,
  newOwner: Address | null,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [writableSigner(owner), writableAccount(storagePda)],
    encodeInstructionData(
      CompositeIsmInstructionKind.TransferOwnership,
      option(newOwner, (address) => ADDRESS_CODEC.encode(address)),
    ),
  );
}

export async function getSetCompositeIsmDomainInstruction(
  programAddress: Address,
  owner: TransactionSigner,
  domain: number,
  ism: IsmNode,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  const { address: domainPda } = await deriveCompositeIsmDomainPda(
    programAddress,
    domain,
  );
  return buildInstruction(
    programAddress,
    [
      writableSigner(owner),
      readonlyAccount(storagePda),
      writableAccount(domainPda),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeInstructionData(
      CompositeIsmInstructionKind.SetDomainIsm,
      concatBytes(u32le(domain), encodeIsmNode(ism)),
    ),
  );
}

export async function getRemoveCompositeIsmDomainInstruction(
  programAddress: Address,
  owner: TransactionSigner,
  domain: number,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  const { address: domainPda } = await deriveCompositeIsmDomainPda(
    programAddress,
    domain,
  );
  return buildInstruction(
    programAddress,
    [
      writableSigner(owner),
      readonlyAccount(storagePda),
      writableAccount(domainPda),
    ],
    encodeInstructionData(
      CompositeIsmInstructionKind.RemoveDomainIsm,
      u32le(domain),
    ),
  );
}

export async function getPauseCompositeIsmInstruction(
  programAddress: Address,
  owner: TransactionSigner,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [writableSigner(owner), writableAccount(storagePda)],
    encodeInstructionData(CompositeIsmInstructionKind.Pause, []),
  );
}

export async function getUnpauseCompositeIsmInstruction(
  programAddress: Address,
  owner: TransactionSigner,
): Promise<Instruction> {
  const { address: storagePda } =
    await deriveCompositeIsmStoragePda(programAddress);
  return buildInstruction(
    programAddress,
    [writableSigner(owner), writableAccount(storagePda)],
    encodeInstructionData(CompositeIsmInstructionKind.Unpause, []),
  );
}
