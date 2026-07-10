import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import {
  fixCodecSize,
  getAddressCodec,
  getBytesCodec,
  getNullableCodec,
  getStructDecoder,
  getStructEncoder,
  getU32Codec,
  getU64Codec,
} from '@solana/kit';

import {
  ByteCursor,
  concatBytes,
  i64le,
  option,
  u8,
  vec,
} from '../codecs/binary.js';
import {
  decodeSetQuoteSignerOperation,
  decodeSvmSignedQuote,
  encodeSetQuoteSignerOperation,
  encodeSvmSignedQuote,
  type SetQuoteSignerOp,
  type SvmSignedQuote,
} from '../codecs/fee.js';
import {
  decodeGetIgpQuoteAccountMetasInput,
  decodeIgpFeeConfig,
  encodeGetIgpQuoteAccountMetasInput,
  encodeIgpFeeConfig,
  type GetIgpQuoteAccountMetasInput,
  type IgpFeeConfig,
} from '../codecs/igp.js';
import {
  encodeGasOracleConfig,
  encodeGasOverheadConfig,
  type GasOracleConfig,
  type GasOverheadConfig,
  type H256,
} from '../codecs/shared.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from './utils.js';

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
  SetIgpQuoteConfig = 11,
  SetIgpQuoteSigner = 12,
  SetIgpMinIssuedAt = 13,
  SubmitIgpQuote = 14,
  CloseIgpTransientQuote = 15,
  CloseIgpStandingQuote = 16,
  GetIgpQuoteAccountMetas = 17,
}

export interface InitIgpData {
  salt: H256;
  owner: Address | null;
  beneficiary: Address;
}

export interface InitOverheadIgpData {
  salt: H256;
  owner: Address | null;
  inner: Address;
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
  | { kind: 'transferIgpOwnership'; newOwner: Address | null }
  | { kind: 'transferOverheadIgpOwnership'; newOwner: Address | null }
  | { kind: 'setIgpBeneficiary'; beneficiary: Address }
  | { kind: 'setDestinationGasOverheads'; configs: GasOverheadConfig[] }
  | { kind: 'setGasOracleConfigs'; configs: GasOracleConfig[] }
  | { kind: 'claim' }
  | { kind: 'setIgpQuoteConfig'; config: IgpFeeConfig | null }
  | { kind: 'setIgpQuoteSigner'; operation: SetQuoteSignerOp; signer: string }
  | { kind: 'setIgpMinIssuedAt'; minIssuedAt: bigint }
  | { kind: 'submitIgpQuote'; quote: SvmSignedQuote }
  | { kind: 'closeIgpTransientQuote' }
  | { kind: 'closeIgpStandingQuote' }
  | { kind: 'getIgpQuoteAccountMetas'; input: GetIgpQuoteAccountMetasInput };

const BYTES32_CODEC = fixCodecSize(getBytesCodec(), 32);
const ADDRESS_CODEC = getAddressCodec();
const OPTIONAL_ADDRESS_CODEC = getNullableCodec(ADDRESS_CODEC);

const INIT_IGP_ENCODER = getStructEncoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_ADDRESS_CODEC],
  ['beneficiary', ADDRESS_CODEC],
]);
const INIT_IGP_DECODER = getStructDecoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_ADDRESS_CODEC],
  ['beneficiary', ADDRESS_CODEC],
]);

const INIT_OVERHEAD_IGP_ENCODER = getStructEncoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_ADDRESS_CODEC],
  ['inner', ADDRESS_CODEC],
]);
const INIT_OVERHEAD_IGP_DECODER = getStructDecoder([
  ['salt', BYTES32_CODEC],
  ['owner', OPTIONAL_ADDRESS_CODEC],
  ['inner', ADDRESS_CODEC],
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
        option(instruction.newOwner, (addr) => ADDRESS_CODEC.encode(addr)),
      );
    case 'transferOverheadIgpOwnership':
      return concatBytes(
        u8(IgpInstructionKind.TransferOverheadIgpOwnership),
        option(instruction.newOwner, (addr) => ADDRESS_CODEC.encode(addr)),
      );
    case 'setIgpBeneficiary':
      return concatBytes(
        u8(IgpInstructionKind.SetIgpBeneficiary),
        ADDRESS_CODEC.encode(instruction.beneficiary),
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
    case 'setIgpQuoteConfig':
      return concatBytes(
        u8(IgpInstructionKind.SetIgpQuoteConfig),
        option(instruction.config, (cfg) => encodeIgpFeeConfig(cfg)),
      );
    case 'setIgpQuoteSigner':
      return concatBytes(
        u8(IgpInstructionKind.SetIgpQuoteSigner),
        encodeSetQuoteSignerOperation(
          instruction.operation,
          instruction.signer,
        ),
      );
    case 'setIgpMinIssuedAt':
      return concatBytes(
        u8(IgpInstructionKind.SetIgpMinIssuedAt),
        i64le(instruction.minIssuedAt),
      );
    case 'submitIgpQuote':
      return concatBytes(
        u8(IgpInstructionKind.SubmitIgpQuote),
        encodeSvmSignedQuote(instruction.quote),
      );
    case 'closeIgpTransientQuote':
      return u8(IgpInstructionKind.CloseIgpTransientQuote);
    case 'closeIgpStandingQuote':
      return u8(IgpInstructionKind.CloseIgpStandingQuote);
    case 'getIgpQuoteAccountMetas':
      return concatBytes(
        u8(IgpInstructionKind.GetIgpQuoteAccountMetas),
        encodeGetIgpQuoteAccountMetasInput(instruction.input),
      );
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
    case IgpInstructionKind.SetIgpQuoteConfig: {
      const cursor = new ByteCursor(payload);
      const tag = cursor.readU8();
      if (tag === 0) {
        return { kind: 'setIgpQuoteConfig', config: null };
      }
      if (tag !== 1) {
        throw new Error(`Invalid SetIgpQuoteConfig option tag: ${tag}`);
      }
      return {
        kind: 'setIgpQuoteConfig',
        config: decodeIgpFeeConfig(cursor),
      };
    }
    case IgpInstructionKind.SetIgpQuoteSigner: {
      const cursor = new ByteCursor(payload);
      const { operation, signer } = decodeSetQuoteSignerOperation(cursor);
      return { kind: 'setIgpQuoteSigner', operation, signer };
    }
    case IgpInstructionKind.SetIgpMinIssuedAt: {
      const cursor = new ByteCursor(payload);
      return { kind: 'setIgpMinIssuedAt', minIssuedAt: cursor.readI64LE() };
    }
    case IgpInstructionKind.SubmitIgpQuote: {
      const cursor = new ByteCursor(payload);
      return { kind: 'submitIgpQuote', quote: decodeSvmSignedQuote(cursor) };
    }
    case IgpInstructionKind.CloseIgpTransientQuote:
      return { kind: 'closeIgpTransientQuote' };
    case IgpInstructionKind.CloseIgpStandingQuote:
      return { kind: 'closeIgpStandingQuote' };
    case IgpInstructionKind.GetIgpQuoteAccountMetas: {
      const cursor = new ByteCursor(payload);
      return {
        kind: 'getIgpQuoteAccountMetas',
        input: decodeGetIgpQuoteAccountMetasInput(cursor),
      };
    }
    default:
      if (kind <= IgpInstructionKind.Claim) {
        throw new Error(
          `IGP instruction kind ${kind} is recognized but decoding is not yet implemented`,
        );
      }
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
      writableSigner(payer),
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
      writableSigner(payer),
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
      writableSigner(payer),
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
    owner: decoded.owner,
    beneficiary: decoded.beneficiary,
  };
}

function encodeInitOverheadIgp(value: InitOverheadIgpData): Uint8Array {
  return Uint8Array.from(INIT_OVERHEAD_IGP_ENCODER.encode(value));
}

function decodeInitOverheadIgp(data: Uint8Array): InitOverheadIgpData {
  const decoded = INIT_OVERHEAD_IGP_DECODER.decode(data);
  return {
    salt: Uint8Array.from(decoded.salt),
    owner: decoded.owner,
    inner: decoded.inner,
  };
}

export async function getSetGasOracleConfigsInstruction(
  programAddress: Address,
  owner: Address,
  igpAccount: Address,
  configs: GasOracleConfig[],
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(igpAccount),
      writableSignerAddress(owner),
    ],
    encodeIgpProgramInstruction({ kind: 'setGasOracleConfigs', configs }),
  );
}

export async function getSetDestinationGasOverheadsInstruction(
  programAddress: Address,
  owner: Address,
  overheadIgpAccount: Address,
  configs: GasOverheadConfig[],
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(overheadIgpAccount),
      writableSignerAddress(owner),
    ],
    encodeIgpProgramInstruction({
      kind: 'setDestinationGasOverheads',
      configs,
    }),
  );
}

export async function getSetIgpQuoteConfigInstruction(
  programAddress: Address,
  owner: Address,
  igpAccount: Address,
  config: IgpFeeConfig | null,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(igpAccount),
      writableSignerAddress(owner),
    ],
    encodeIgpProgramInstruction({ kind: 'setIgpQuoteConfig', config }),
  );
}

export async function getSetIgpQuoteSignerInstruction(
  programAddress: Address,
  owner: Address,
  igpAccount: Address,
  operation: SetQuoteSignerOp,
  signer: string,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(igpAccount),
      writableSignerAddress(owner),
    ],
    encodeIgpProgramInstruction({
      kind: 'setIgpQuoteSigner',
      operation,
      signer,
    }),
  );
}

export async function getSetIgpMinIssuedAtInstruction(
  programAddress: Address,
  owner: Address,
  igpAccount: Address,
  minIssuedAt: bigint,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(igpAccount),
      writableSignerAddress(owner),
    ],
    encodeIgpProgramInstruction({ kind: 'setIgpMinIssuedAt', minIssuedAt }),
  );
}

export async function getSubmitIgpQuoteInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  igpAccount: Address,
  quotePda: Address,
  quote: SvmSignedQuote,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSigner(payer),
      readonlyAccount(igpAccount),
      writableAccount(quotePda),
    ],
    encodeIgpProgramInstruction({ kind: 'submitIgpQuote', quote }),
  );
}

export async function getCloseIgpTransientQuoteInstruction(
  programAddress: Address,
  transientPda: Address,
  payer: TransactionSigner,
  igpAccount: Address,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      writableAccount(transientPda),
      writableSigner(payer),
      readonlyAccount(igpAccount),
    ],
    encodeIgpProgramInstruction({ kind: 'closeIgpTransientQuote' }),
  );
}

export async function getCloseIgpStandingQuoteInstruction(
  programAddress: Address,
  standingPda: Address,
  igpAccount: Address,
  beneficiary: Address,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [
      writableAccount(standingPda),
      readonlyAccount(igpAccount),
      writableAccount(beneficiary),
    ],
    encodeIgpProgramInstruction({ kind: 'closeIgpStandingQuote' }),
  );
}

export async function getGetIgpQuoteAccountMetasInstruction(
  programAddress: Address,
  igpAccount: Address,
  input: GetIgpQuoteAccountMetasInput,
): Promise<Instruction> {
  return buildInstruction(
    programAddress,
    [readonlyAccount(igpAccount)],
    encodeIgpProgramInstruction({ kind: 'getIgpQuoteAccountMetas', input }),
  );
}
