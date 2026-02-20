import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import {
  fixCodecSize,
  getBytesCodec,
  getNullableCodec,
  getStructDecoder,
  getStructEncoder,
  getU32Codec,
  getU64Codec,
} from '@solana/kit';

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { concatBytes, option, u8, vec } from '../codecs/binary.js';
import {
  encodeGasOracle,
  encodeGasOracleConfig,
  encodeGasOverheadConfig,
  type GasOracleConfig,
  type GasOverheadConfig,
  type H256,
} from '../codecs/shared.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySigner,
  writableAccount,
} from './utils.js';
import {
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';

export enum IgpInstructionKind {
  Init = 0,
  InitIgp = 1,
  InitOverheadIgp = 2,
  PayForGas = 3,
  QuoteGasPayment = 4,
  TransferIgpOwnership = 5,
  TransferOverheadIgpOwnership = 6,
  SetIgpBeneficiary = 7,
  SetDestinationGasOverheads = 8,
  SetGasOracleConfigs = 9,
  Claim = 10,
}

export interface InitIgpData {
  salt: H256;
  owner: Uint8Array | null;
  beneficiary: Uint8Array;
}

export interface InitOverheadIgpData {
  salt: H256;
  owner: Uint8Array | null;
  inner: Uint8Array;
}

export interface QuoteGasPaymentData {
  destinationDomain: number;
  gasAmount: bigint;
}

export type IgpProgramInstructionData =
  | { kind: 'init' }
  | { kind: 'initIgp'; value: InitIgpData }
  | { kind: 'initOverheadIgp'; value: InitOverheadIgpData }
  | { kind: 'quoteGasPayment'; value: QuoteGasPaymentData }
  | { kind: 'transferIgpOwnership'; newOwner: Uint8Array | null }
  | { kind: 'transferOverheadIgpOwnership'; newOwner: Uint8Array | null }
  | { kind: 'setIgpBeneficiary'; beneficiary: Uint8Array }
  | { kind: 'setDestinationGasOverheads'; configs: GasOverheadConfig[] }
  | { kind: 'setGasOracleConfigs'; configs: GasOracleConfig[] }
  | { kind: 'claim' };

const BYTES32_CODEC = fixCodecSize(getBytesCodec(), 32);
const OPTIONAL_BYTES32_CODEC = getNullableCodec(BYTES32_CODEC);

const INIT_IGP_ENCODER = getStructEncoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_BYTES32_CODEC],
  ['beneficiary', BYTES32_CODEC],
]);
const INIT_IGP_DECODER = getStructDecoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_BYTES32_CODEC],
  ['beneficiary', BYTES32_CODEC],
]);

const INIT_OVERHEAD_IGP_ENCODER = getStructEncoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_BYTES32_CODEC],
  ['inner', BYTES32_CODEC],
]);
const INIT_OVERHEAD_IGP_DECODER = getStructDecoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_BYTES32_CODEC],
  ['inner', BYTES32_CODEC],
]);

const QUOTE_GAS_PAYMENT_ENCODER = getStructEncoder([
  ['destinationDomain', getU32Codec()],
  ['gasAmount', getU64Codec()],
]);
const QUOTE_GAS_PAYMENT_DECODER = getStructDecoder([
  ['destinationDomain', getU32Codec()],
  ['gasAmount', getU64Codec()],
]);

export function encodeIgpProgramInstruction(
  instruction: IgpProgramInstructionData,
): ReadonlyUint8Array {
  switch (instruction.kind) {
    case 'init':
      return u8(IgpInstructionKind.Init);
    case 'initIgp':
      return concatBytes(
        u8(IgpInstructionKind.InitIgp),
        encodeInitIgp(instruction.value),
      );
    case 'initOverheadIgp':
      return concatBytes(
        u8(IgpInstructionKind.InitOverheadIgp),
        encodeInitOverheadIgp(instruction.value),
      );
    case 'quoteGasPayment':
      return concatBytes(
        u8(IgpInstructionKind.QuoteGasPayment),
        Uint8Array.from(QUOTE_GAS_PAYMENT_ENCODER.encode(instruction.value)),
      );
    case 'transferIgpOwnership':
      return concatBytes(
        u8(IgpInstructionKind.TransferIgpOwnership),
        option(instruction.newOwner, (owner) => owner),
      );
    case 'transferOverheadIgpOwnership':
      return concatBytes(
        u8(IgpInstructionKind.TransferOverheadIgpOwnership),
        option(instruction.newOwner, (owner) => owner),
      );
    case 'setIgpBeneficiary':
      return concatBytes(
        u8(IgpInstructionKind.SetIgpBeneficiary),
        instruction.beneficiary,
      );
    case 'setDestinationGasOverheads':
      return concatBytes(
        u8(IgpInstructionKind.SetDestinationGasOverheads),
        vec(instruction.configs, encodeGasOverheadConfig),
      );
    case 'setGasOracleConfigs':
      return concatBytes(
        u8(IgpInstructionKind.SetGasOracleConfigs),
        vec(instruction.configs, encodeGasOracleConfig),
      );
    case 'claim':
      return u8(IgpInstructionKind.Claim);
  }
}

export function decodeIgpProgramInstruction(
  data: Uint8Array,
): IgpProgramInstructionData | null {
  if (data.length < 1) return null;
  const kind = data[0]!;
  const payload = data.slice(1);
  switch (kind) {
    case IgpInstructionKind.Init:
      return { kind: 'init' };
    case IgpInstructionKind.InitIgp:
      return { kind: 'initIgp', value: decodeInitIgp(payload) };
    case IgpInstructionKind.InitOverheadIgp:
      return { kind: 'initOverheadIgp', value: decodeInitOverheadIgp(payload) };
    case IgpInstructionKind.QuoteGasPayment: {
      const decoded = QUOTE_GAS_PAYMENT_DECODER.decode(payload);
      return {
        kind: 'quoteGasPayment',
        value: {
          destinationDomain: decoded.destinationDomain,
          gasAmount: decoded.gasAmount,
        },
      };
    }
    default:
      return null;
  }
}

export async function getInitIgpProgramInstruction(
  programAddress: Address,
  payer: TransactionSigner,
): Promise<Instruction> {
  const { address: programData } =
    await deriveIgpProgramDataPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlySigner(payer),
      writableAccount(programData),
    ],
    encodeIgpProgramInstruction({ kind: 'init' }),
  );
}

export async function getInitIgpInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  value: InitIgpData,
): Promise<Instruction> {
  const { address: igpAccount } = await deriveIgpAccountPda(
    programAddress,
    value.salt,
  );
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlySigner(payer),
      writableAccount(igpAccount),
    ],
    encodeIgpProgramInstruction({ kind: 'initIgp', value }),
  );
}

export async function getInitOverheadIgpInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  value: InitOverheadIgpData,
): Promise<Instruction> {
  const { address: overheadIgpAccount } = await deriveOverheadIgpAccountPda(
    programAddress,
    value.salt,
  );
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlySigner(payer),
      writableAccount(overheadIgpAccount),
    ],
    encodeIgpProgramInstruction({ kind: 'initOverheadIgp', value }),
  );
}

function encodeInitIgp(value: InitIgpData): Uint8Array {
  return Uint8Array.from(INIT_IGP_ENCODER.encode(value));
}

function decodeInitIgp(data: Uint8Array): InitIgpData {
  const decoded = INIT_IGP_DECODER.decode(data);
  return {
    salt: Uint8Array.from(decoded.salt),
    owner: decoded.owner ? Uint8Array.from(decoded.owner) : null,
    beneficiary: Uint8Array.from(decoded.beneficiary),
  };
}

function encodeInitOverheadIgp(value: InitOverheadIgpData): Uint8Array {
  return Uint8Array.from(INIT_OVERHEAD_IGP_ENCODER.encode(value));
}

function decodeInitOverheadIgp(data: Uint8Array): InitOverheadIgpData {
  const decoded = INIT_OVERHEAD_IGP_DECODER.decode(data);
  return {
    salt: Uint8Array.from(decoded.salt),
    owner: decoded.owner ? Uint8Array.from(decoded.owner) : null,
    inner: Uint8Array.from(decoded.inner),
  };
}

export function _encodeGasOracleForTests(config: GasOracleConfig): Uint8Array {
  return encodeGasOracleConfig(config);
}

export function _encodeGasOracleRawForTests(
  tokenExchangeRate: bigint,
  gasPrice: bigint,
  tokenDecimals: number,
): Uint8Array {
  return encodeGasOracle({
    kind: 0,
    value: { tokenExchangeRate, gasPrice, tokenDecimals },
  });
}
