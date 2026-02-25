import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import {
  getAddressCodec,
  getNullableDecoder,
  getNullableEncoder,
  getNullableCodec,
  getStructDecoder,
  getStructEncoder,
  getU8Codec,
} from '@solana/kit';

import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  ByteCursor,
  concatBytes,
  option,
  u8,
  u32le,
  u256le,
  vec,
} from '../codecs/binary.js';
import {
  decodeInterchainGasPaymasterType,
  encodeGasRouterConfig,
  encodeInterchainGasPaymasterType,
  encodeRemoteRouterConfig,
  encodeH256,
  type GasRouterConfig,
  type H256,
  type InterchainGasPaymasterType,
  InterchainGasPaymasterTypeKind,
  type RemoteRouterConfig,
} from '../codecs/shared.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySigner,
  readonlySignerAddress,
  writableAccount,
} from './utils.js';
import {
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
} from '../pda.js';

export enum TokenProgramInstructionKind {
  Init = 0,
  TransferRemote = 1,
  EnrollRemoteRouter = 2,
  EnrollRemoteRouters = 3,
  SetDestinationGasConfigs = 4,
  SetInterchainSecurityModule = 5,
  SetInterchainGasPaymaster = 6,
  TransferOwnership = 7,
}

export interface TokenInitInstructionData {
  mailbox: Address;
  interchainSecurityModule: Address | null;
  interchainGasPaymaster: {
    programId: Address;
    igp: InterchainGasPaymasterType;
  } | null;
  decimals: number;
  remoteDecimals: number;
}

export interface TransferRemoteInstructionData {
  destinationDomain: number;
  recipient: H256;
  amountOrId: bigint;
}

export type TokenProgramInstructionData =
  | { kind: 'init'; value: TokenInitInstructionData }
  | { kind: 'transferRemote'; value: TransferRemoteInstructionData }
  | { kind: 'enrollRemoteRouter'; value: RemoteRouterConfig }
  | { kind: 'enrollRemoteRouters'; value: RemoteRouterConfig[] }
  | { kind: 'setDestinationGasConfigs'; value: GasRouterConfig[] }
  | { kind: 'setInterchainSecurityModule'; value: Address | null }
  | {
      kind: 'setInterchainGasPaymaster';
      value: [Address, InterchainGasPaymasterType] | null;
    }
  | { kind: 'transferOwnership'; value: Address | null };

interface TokenInitIgpValue {
  programId: Address;
  igpKind: number;
  igpAccount: Address;
}

interface TokenInitCodecValue {
  mailbox: Address;
  interchainSecurityModule: Address | null;
  interchainGasPaymaster: TokenInitIgpValue | null;
  decimals: number;
  remoteDecimals: number;
}

const ADDRESS_CODEC = getAddressCodec();
const OPTIONAL_ADDRESS_CODEC = getNullableCodec(ADDRESS_CODEC);
const U8_CODEC = getU8Codec();
const IGP_VALUE_CODEC = getStructEncoder([
  ['programId', ADDRESS_CODEC],
  ['igpKind', U8_CODEC],
  ['igpAccount', ADDRESS_CODEC],
]);
const IGP_VALUE_DECODER = getStructDecoder([
  ['programId', ADDRESS_CODEC],
  ['igpKind', U8_CODEC],
  ['igpAccount', ADDRESS_CODEC],
]);
const OPTIONAL_IGP_ENCODER = getNullableEncoder(IGP_VALUE_CODEC);
const OPTIONAL_IGP_DECODER = getNullableDecoder(IGP_VALUE_DECODER);
const TOKEN_INIT_ENCODER = getStructEncoder([
  ['mailbox', ADDRESS_CODEC],
  ['interchainSecurityModule', OPTIONAL_ADDRESS_CODEC],
  ['interchainGasPaymaster', OPTIONAL_IGP_ENCODER],
  ['decimals', U8_CODEC],
  ['remoteDecimals', U8_CODEC],
]);
const TOKEN_INIT_DECODER = getStructDecoder([
  ['mailbox', ADDRESS_CODEC],
  ['interchainSecurityModule', OPTIONAL_ADDRESS_CODEC],
  ['interchainGasPaymaster', OPTIONAL_IGP_DECODER],
  ['decimals', U8_CODEC],
  ['remoteDecimals', U8_CODEC],
]);

export function encodeTokenProgramInstruction(
  instruction: TokenProgramInstructionData,
): ReadonlyUint8Array {
  switch (instruction.kind) {
    case 'init':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.Init),
        encodeTokenInit(instruction.value),
      );
    case 'transferRemote':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.TransferRemote),
        encodeTransferRemote(instruction.value),
      );
    case 'enrollRemoteRouter':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.EnrollRemoteRouter),
        encodeRemoteRouterConfig(instruction.value),
      );
    case 'enrollRemoteRouters':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.EnrollRemoteRouters),
        vec(instruction.value, encodeRemoteRouterConfig),
      );
    case 'setDestinationGasConfigs':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.SetDestinationGasConfigs),
        vec(instruction.value, encodeGasRouterConfig),
      );
    case 'setInterchainSecurityModule':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.SetInterchainSecurityModule),
        option(instruction.value, (addr) => ADDRESS_CODEC.encode(addr)),
      );
    case 'setInterchainGasPaymaster':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.SetInterchainGasPaymaster),
        option(instruction.value, ([programId, igp]) =>
          concatBytes(
            ADDRESS_CODEC.encode(programId),
            encodeInterchainGasPaymasterType(igp),
          ),
        ),
      );
    case 'transferOwnership':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.TransferOwnership),
        option(instruction.value, (addr) => ADDRESS_CODEC.encode(addr)),
      );
  }
}

export function decodeTokenProgramInstruction(
  data: Uint8Array,
): TokenProgramInstructionData | null {
  if (data.length < 9) return null;
  const cursor = new ByteCursor(data);
  const prefix = cursor.readBytes(8);
  if (!prefix.every((v) => v === 1)) return null;

  const kind = cursor.readU8();
  switch (kind) {
    case TokenProgramInstructionKind.Init:
      return {
        kind: 'init',
        value: decodeTokenInit(cursor.readBytes(cursor.remaining())),
      };
    case TokenProgramInstructionKind.TransferRemote:
      return { kind: 'transferRemote', value: decodeTransferRemote(cursor) };
    case TokenProgramInstructionKind.EnrollRemoteRouter:
      return {
        kind: 'enrollRemoteRouter',
        value: decodeRemoteRouterConfig(cursor),
      };
    case TokenProgramInstructionKind.EnrollRemoteRouters:
      return {
        kind: 'enrollRemoteRouters',
        value: decodeVec(cursor, decodeRemoteRouterConfig),
      };
    case TokenProgramInstructionKind.SetDestinationGasConfigs:
      return {
        kind: 'setDestinationGasConfigs',
        value: decodeVec(cursor, decodeGasRouterConfig),
      };
    case TokenProgramInstructionKind.SetInterchainSecurityModule:
      return {
        kind: 'setInterchainSecurityModule',
        value: decodeOptionAddress(cursor),
      };
    case TokenProgramInstructionKind.SetInterchainGasPaymaster:
      return {
        kind: 'setInterchainGasPaymaster',
        value: decodeOptionIgpTuple(cursor),
      };
    case TokenProgramInstructionKind.TransferOwnership:
      return { kind: 'transferOwnership', value: decodeOptionAddress(cursor) };
    default:
      return null;
  }
}

export async function getTokenInitInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  init: TokenInitInstructionData,
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  const { address: dispatchAuthority } =
    await deriveMailboxDispatchAuthorityPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(tokenPda),
      writableAccount(dispatchAuthority),
      readonlySigner(payer),
    ],
    encodeTokenProgramInstruction({ kind: 'init', value: init }),
  );
}

export async function getTokenTransferOwnershipInstruction(
  programAddress: Address,
  owner: Address,
  newOwner: Address | null,
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  return buildInstruction(
    programAddress,
    [writableAccount(tokenPda), readonlySignerAddress(owner)],
    encodeTokenProgramInstruction({
      kind: 'transferOwnership',
      value: newOwner,
    }),
  );
}

export async function getTokenSetInterchainSecurityModuleInstruction(
  programAddress: Address,
  owner: Address,
  newIsm: Address | null,
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  return buildInstruction(
    programAddress,
    [writableAccount(tokenPda), readonlySignerAddress(owner)],
    encodeTokenProgramInstruction({
      kind: 'setInterchainSecurityModule',
      value: newIsm,
    }),
  );
}

export async function getTokenSetInterchainGasPaymasterInstruction(
  programAddress: Address,
  owner: Address,
  value: [Address, InterchainGasPaymasterType] | null,
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  return buildInstruction(
    programAddress,
    [writableAccount(tokenPda), readonlySignerAddress(owner)],
    encodeTokenProgramInstruction({ kind: 'setInterchainGasPaymaster', value }),
  );
}

export async function getTokenEnrollRemoteRoutersInstruction(
  programAddress: Address,
  owner: Address,
  routers: RemoteRouterConfig[],
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(tokenPda),
      readonlySignerAddress(owner),
    ],
    encodeTokenProgramInstruction({
      kind: 'enrollRemoteRouters',
      value: routers,
    }),
  );
}

export async function getTokenSetDestinationGasConfigsInstruction(
  programAddress: Address,
  owner: Address,
  gasConfigs: GasRouterConfig[],
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(tokenPda),
      readonlySignerAddress(owner),
    ],
    encodeTokenProgramInstruction({
      kind: 'setDestinationGasConfigs',
      value: gasConfigs,
    }),
  );
}

function encodeTokenInit(value: TokenInitInstructionData): Uint8Array {
  const normalized: TokenInitCodecValue = {
    mailbox: value.mailbox,
    interchainSecurityModule: value.interchainSecurityModule,
    interchainGasPaymaster: value.interchainGasPaymaster
      ? {
          programId: value.interchainGasPaymaster.programId,
          igpKind: value.interchainGasPaymaster.igp.kind,
          igpAccount: value.interchainGasPaymaster.igp.account,
        }
      : null,
    decimals: value.decimals,
    remoteDecimals: value.remoteDecimals,
  };
  return Uint8Array.from(TOKEN_INIT_ENCODER.encode(normalized));
}

function decodeTokenInit(data: Uint8Array): TokenInitInstructionData {
  const decoded = TOKEN_INIT_DECODER.decode(data);
  const igp = decoded.interchainGasPaymaster;

  return {
    mailbox: decoded.mailbox,
    interchainSecurityModule: decoded.interchainSecurityModule,
    interchainGasPaymaster: igp
      ? {
          programId: igp.programId,
          igp: {
            kind: igp.igpKind as InterchainGasPaymasterTypeKind,
            account: igp.igpAccount,
          },
        }
      : null,
    decimals: decoded.decimals,
    remoteDecimals: decoded.remoteDecimals,
  };
}

function encodeTransferRemote(
  value: TransferRemoteInstructionData,
): ReadonlyUint8Array {
  return concatBytes(
    u32le(value.destinationDomain),
    encodeH256(value.recipient),
    u256le(value.amountOrId),
  );
}

function decodeTransferRemote(
  cursor: ByteCursor,
): TransferRemoteInstructionData {
  return {
    destinationDomain: cursor.readU32LE(),
    recipient: cursor.readBytes(32),
    amountOrId: cursor.readU256LE(),
  };
}

function decodeRemoteRouterConfig(cursor: ByteCursor): RemoteRouterConfig {
  const domain = cursor.readU32LE();
  const hasRouter = cursor.readU8() === 1;
  return {
    domain,
    router: hasRouter ? cursor.readBytes(32) : null,
  };
}

function decodeGasRouterConfig(cursor: ByteCursor): GasRouterConfig {
  const domain = cursor.readU32LE();
  const hasGas = cursor.readU8() === 1;
  return {
    domain,
    gas: hasGas ? cursor.readU64LE() : null,
  };
}

function decodeOptionAddress(cursor: ByteCursor): Address | null {
  const hasValue = cursor.readU8() === 1;
  return hasValue ? ADDRESS_CODEC.decode(cursor.readBytes(32)) : null;
}

function decodeOptionIgpTuple(
  cursor: ByteCursor,
): [Address, InterchainGasPaymasterType] | null {
  const hasValue = cursor.readU8() === 1;
  if (!hasValue) return null;
  return [
    ADDRESS_CODEC.decode(cursor.readBytes(32)),
    decodeInterchainGasPaymasterType(cursor),
  ];
}

function decodeVec<T>(
  cursor: ByteCursor,
  decoder: (cursor: ByteCursor) => T,
): T[] {
  const length = cursor.readU32LE();
  const out: T[] = [];
  for (let i = 0; i < length; i += 1) {
    out.push(decoder(cursor));
  }
  return out;
}
