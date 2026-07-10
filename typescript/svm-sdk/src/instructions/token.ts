import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import {
  getAddressCodec,
  getNullableCodec,
  getNullableDecoder,
  getNullableEncoder,
  getStructDecoder,
  getStructEncoder,
  getU8Codec,
} from '@solana/kit';

import {
  ByteCursor,
  concatBytes,
  option,
  u256le,
  u32le,
  u8,
  vec,
} from '../codecs/binary.js';
import {
  decodeInterchainGasPaymasterType,
  encodeGasRouterConfig,
  encodeH256,
  encodeInterchainGasPaymasterType,
  encodeRemoteRouterConfig,
  type GasRouterConfig,
  type H256,
  type InterchainGasPaymasterType,
  InterchainGasPaymasterTypeKind,
  type RemoteRouterConfig,
} from '../codecs/shared.js';
import type { TokenFeeConfig } from '../accounts/token.js';
import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SPL_NOOP_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveMailboxDispatchedMessagePda,
  deriveMailboxOutboxPda,
} from '../pda.js';
import {
  buildInstruction,
  type InstructionAccountMeta,
  readonlyAccount,
  readonlySigner,
  readonlySignerAddress,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from './utils.js';

export enum TokenProgramInstructionKind {
  Init = 0,
  TransferRemote = 1,
  EnrollRemoteRouter = 2,
  EnrollRemoteRouters = 3,
  SetDestinationGasConfigs = 4,
  SetInterchainSecurityModule = 5,
  SetInterchainGasPaymaster = 6,
  TransferOwnership = 7,
  TransferRemoteWithMemo = 8,
  SetFeeConfig = 9,
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
  | { kind: 'transferOwnership'; value: Address | null }
  | { kind: 'setFeeConfig'; value: TokenFeeConfig | null };

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
    case 'setFeeConfig':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(TokenProgramInstructionKind.SetFeeConfig),
        option(instruction.value, (fc) =>
          concatBytes(
            ADDRESS_CODEC.encode(fc.feeProgram),
            ADDRESS_CODEC.encode(fc.feeAccount),
          ),
        ),
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
    case TokenProgramInstructionKind.SetFeeConfig:
      return { kind: 'setFeeConfig', value: decodeOptionFeeConfig(cursor) };
    default:
      if (kind <= TokenProgramInstructionKind.SetFeeConfig) {
        throw new Error(
          `Token instruction kind ${kind} is recognized but decoding is not yet implemented`,
        );
      }
      return null;
  }
}

/**
 * Optional fee section consumed by warp token `transfer_remote`.
 * Appended between the static prefix and the IGP section when the warp
 * token has a `fee_config` set on-chain.
 *
 *   feeProgram
 *   feeAccount
 *   ...passThroughAccounts (0..15 — cascade quote PDAs, route PDAs, etc.)
 *   feeBeneficiary (writable, terminal sentinel)
 */
export interface FeeTransferRemoteSection {
  feeProgram: Address;
  feeAccount: Address;
  /** Variable QuoteFee pass-through accounts (e.g. standing-quote PDAs). */
  passThroughAccounts?: InstructionAccountMeta[];
  feeBeneficiary: Address;
}

export function buildFeeTransferRemoteSectionAccounts(
  fee: FeeTransferRemoteSection,
): InstructionAccountMeta[] {
  return [
    readonlyAccount(fee.feeProgram),
    readonlyAccount(fee.feeAccount),
    ...(fee.passThroughAccounts ?? []),
    writableAccount(fee.feeBeneficiary),
  ];
}

/**
 * Optional "quoted-mode" extension to the IGP section. When set, the IGP
 * uses offchain quote pricing and the warp program invokes PayForGas with
 * `invoke_signed` using the route's `igp_quote_authority` PDA. The matching
 * `SubmitIgpQuote` instruction must run earlier in the same transaction.
 */
export interface IgpQuotedExtension {
  /**
   * The route's dedicated `igp_quote_authority` PDA (derive via
   * `deriveIgpQuoteAuthorityPda`) — distinct from the mailbox and CC
   * dispatch-authority PDAs. The IGP signs the quoted PayForGas CPI with
   * this authority.
   */
  senderAuthority: Address;
  /**
   * Warp program id (= the sender). The on-chain IGP rejects the quote
   * unless this matches the `sender` field in the signed quote context.
   */
  senderProgramId: Address;
  /**
   * Cascade standing/transient quote PDAs (0..N), appended after
   * `senderProgramId`. Account roles must mirror what
   * `GetIgpQuoteAccountMetas` returns at simulation time (the transient
   * quote PDA is typically writable since the IGP closes it during
   * consumption).
   */
  cascadeQuotePdas?: InstructionAccountMeta[];
}

/**
 * Optional IGP account section consumed by warp token `transfer_remote`.
 * Layout matches the Rust processor: when the token has an IGP configured,
 * these accounts are appended after the (optional) fee section and before
 * the plugin-specific accounts.
 *
 * Legacy + Igp:           [program, data(w), payment(w), igpAccount(w)]
 * Legacy + OverheadIgp:   [program, data(w), payment(w), overheadIgp(w), innerIgp(w)]
 * Quoted + Igp:           [program, data(w), payment(w), senderAuthority, programAddress,
 *                          ...cascadeQuotePdas, igpAccount(w)]
 * Quoted + OverheadIgp:   [program, data(w), payment(w), senderAuthority, programAddress,
 *                          ...cascadeQuotePdas, overheadIgp(w), innerIgp(w)]
 *
 * `igpAccount` is the configured IGP — for `Igp` types it is the IGP PDA;
 * for `OverheadIgp` types it is the overhead IGP PDA and `innerIgp` must
 * also be set.
 */
export interface IgpTransferRemoteSection {
  programId: Address;
  programData: Address;
  paymentPda: Address;
  igpAccount: Address;
  /** Set only when `igpAccount` is the configured OverheadIgp PDA. */
  innerIgp?: Address;
  /** When set, the IGP uses Quoted-mode pricing. */
  quoted?: IgpQuotedExtension;
}

export function buildIgpTransferRemoteSectionAccounts(
  igp: IgpTransferRemoteSection,
): InstructionAccountMeta[] {
  const accounts: InstructionAccountMeta[] = [
    readonlyAccount(igp.programId),
    writableAccount(igp.programData),
    writableAccount(igp.paymentPda),
  ];
  if (igp.quoted) {
    accounts.push(
      readonlyAccount(igp.quoted.senderAuthority),
      readonlyAccount(igp.quoted.senderProgramId),
      ...(igp.quoted.cascadeQuotePdas ?? []),
    );
  }
  accounts.push(writableAccount(igp.igpAccount));
  if (igp.innerIgp) {
    accounts.push(writableAccount(igp.innerIgp));
  }
  return accounts;
}

/**
 * Builds the warp token `TransferRemote` instruction (collateral / native /
 * synthetic). Mirrors the account ordering in the on-chain processor:
 *
 *   0  system program
 *   1  spl noop
 *   2  token PDA
 *   3  mailbox program
 *   4  mailbox outbox (writable)
 *   5  mailbox dispatch authority PDA
 *   6  sender wallet (signer + payer)
 *   7  unique message account (signer)
 *   8  dispatched message PDA (writable)
 *   --- Fee section (when fee_config is Some) ---
 *   9..M  fee program, fee account, pass-through accounts, fee beneficiary(w)
 *   --- IGP section (when an IGP is configured) ---
 *   M+1..N  IGP program, data(w), payment PDA(w), optional quoted-mode
 *           accounts, configured IGP(w), optional inner IGP(w)
 *   --- Plugin ---
 *   N+1..K  plugin transfer_in accounts (supplied by caller)
 */
export async function getTokenTransferRemoteInstruction(args: {
  programAddress: Address;
  sender: TransactionSigner;
  uniqueMessageAccount: TransactionSigner;
  mailbox: Address;
  data: TransferRemoteInstructionData;
  fee?: FeeTransferRemoteSection;
  igp?: IgpTransferRemoteSection;
  pluginAccounts: InstructionAccountMeta[];
}): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(
    args.programAddress,
  );
  const { address: mailboxOutbox } = await deriveMailboxOutboxPda(args.mailbox);
  const { address: dispatchAuthority } =
    await deriveMailboxDispatchAuthorityPda(args.programAddress);
  const { address: dispatchedMessagePda } =
    await deriveMailboxDispatchedMessagePda(
      args.mailbox,
      args.uniqueMessageAccount.address,
    );

  const accounts: InstructionAccountMeta[] = [
    readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    readonlyAccount(SPL_NOOP_PROGRAM_ADDRESS),
    readonlyAccount(tokenPda),
    readonlyAccount(args.mailbox),
    writableAccount(mailboxOutbox),
    readonlyAccount(dispatchAuthority),
    writableSigner(args.sender),
    readonlySigner(args.uniqueMessageAccount),
    writableAccount(dispatchedMessagePda),
    ...(args.fee ? buildFeeTransferRemoteSectionAccounts(args.fee) : []),
    ...(args.igp ? buildIgpTransferRemoteSectionAccounts(args.igp) : []),
    ...args.pluginAccounts,
  ];

  return buildInstruction(
    args.programAddress,
    accounts,
    encodeTokenProgramInstruction({ kind: 'transferRemote', value: args.data }),
  );
}

export async function getTokenInitInstruction(
  programAddress: Address,
  payer: TransactionSigner,
  init: TokenInitInstructionData,
  pluginAccounts: InstructionAccountMeta[],
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
      writableSigner(payer),
      ...pluginAccounts,
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
      writableSignerAddress(owner),
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
      writableSignerAddress(owner),
    ],
    encodeTokenProgramInstruction({
      kind: 'setDestinationGasConfigs',
      value: gasConfigs,
    }),
  );
}

export function encodeTokenInit(value: TokenInitInstructionData): Uint8Array {
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

function validateIgpKind(value: number): InterchainGasPaymasterTypeKind {
  if (
    value !== InterchainGasPaymasterTypeKind.Igp &&
    value !== InterchainGasPaymasterTypeKind.OverheadIgp
  ) {
    throw new Error(`Unknown InterchainGasPaymasterTypeKind: ${value}`);
  }
  return value;
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
            kind: validateIgpKind(igp.igpKind),
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

function decodeOptionFeeConfig(cursor: ByteCursor): TokenFeeConfig | null {
  const hasValue = cursor.readU8() === 1;
  if (!hasValue) return null;
  return {
    feeProgram: ADDRESS_CODEC.decode(cursor.readBytes(32)),
    feeAccount: ADDRESS_CODEC.decode(cursor.readBytes(32)),
  };
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

// ====== SetFeeConfig instruction builder ======

export async function getTokenSetFeeConfigInstruction(
  programAddress: Address,
  owner: Address,
  mailbox: Address,
  value: TokenFeeConfig | null,
): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
  const accounts = [
    readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    writableAccount(tokenPda),
    writableSignerAddress(owner),
  ];
  if (value) {
    const outboxPda = await deriveMailboxOutboxPda(mailbox);
    accounts.push(
      readonlyAccount(value.feeProgram),
      readonlyAccount(value.feeAccount),
      readonlyAccount(outboxPda.address),
    );
  }
  return buildInstruction(
    programAddress,
    accounts,
    encodeTokenProgramInstruction({ kind: 'setFeeConfig', value }),
  );
}
