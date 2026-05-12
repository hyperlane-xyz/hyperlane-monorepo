import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';

import { concatBytes, u256le, u32le, u8, vec } from '../codecs/binary.js';
import {
  encodeH256,
  encodeRemoteRouterConfig,
  type H256,
  type RemoteRouterConfig,
} from '../codecs/shared.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  deriveCrossCollateralDispatchAuthorityPda,
  deriveCrossCollateralStatePda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveMailboxDispatchedMessagePda,
  deriveMailboxOutboxPda,
} from '../pda.js';
import {
  buildFeeTransferRemoteSectionAccounts,
  buildIgpTransferRemoteSectionAccounts,
  getTokenInitInstruction,
  type FeeTransferRemoteSection,
  type IgpTransferRemoteSection,
  type TokenInitInstructionData,
} from './token.js';
import {
  buildInstruction,
  type InstructionAccountMeta,
  readonlyAccount,
  readonlySigner,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from './utils.js';

// Cross-collateral plugin discriminator [2; 8], distinct from the base
// token program discriminator [1; 8] (PROGRAM_INSTRUCTION_DISCRIMINATOR).
const CC_INSTRUCTION_DISCRIMINATOR = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);

export enum CrossCollateralInstructionKind {
  SetCrossCollateralRouters = 0,
  TransferRemoteTo = 1,
  HandleLocal = 2,
  HandleLocalAccountMetas = 3,
}

export type CrossCollateralRouterUpdate =
  | { kind: 'add'; config: { domain: number; router: H256 } }
  | { kind: 'remove'; config: RemoteRouterConfig };

function encodeCrossCollateralRouterUpdate(
  update: CrossCollateralRouterUpdate,
): ReadonlyUint8Array {
  if (update.kind === 'add') {
    return concatBytes(
      u8(0),
      u32le(update.config.domain),
      encodeH256(update.config.router),
    );
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

export interface TransferRemoteToInstructionData {
  destinationDomain: number;
  recipient: H256;
  amountOrId: bigint;
  targetRouter: H256;
}

function encodeTransferRemoteTo(
  value: TransferRemoteToInstructionData,
): ReadonlyUint8Array {
  return concatBytes(
    u32le(value.destinationDomain),
    encodeH256(value.recipient),
    u256le(value.amountOrId),
    encodeH256(value.targetRouter),
  );
}

/**
 * Builds the cross-collateral `TransferRemoteTo` instruction (remote path).
 * Mirrors the account ordering in
 * `hyperlane-sealevel-token-cross-collateral::transfer_remote_to_remote`:
 *
 *   0  system program
 *   1  token PDA
 *   2  CC state PDA (readonly — `transfer_remote_to_remote` only reads it)
 *   3  spl noop
 *   4  mailbox program
 *   5  mailbox outbox (writable)
 *   6  mailbox dispatch authority PDA (this program's, signs mailbox dispatch)
 *   7  sender wallet (signer + payer)
 *   8  unique message account (signer)
 *   9  dispatched message PDA (writable)
 *   --- Fee section (when fee_config is Some) ---
 *   10..M  fee program, fee account, pass-through accounts, fee beneficiary(w)
 *   --- IGP section (when an IGP is configured) ---
 *   M+1..N IGP program, data(w), payment PDA(w), optional quoted-mode
 *          accounts, configured IGP(w), optional inner IGP(w)
 *   --- Plugin ---
 *   N+1..K plugin transfer_in accounts (supplied by caller)
 *
 * The same-chain (`destination_domain == local_domain`) path uses a
 * different account layout and is not produced by this builder.
 */
export async function getCrossCollateralTransferRemoteToInstruction(args: {
  programAddress: Address;
  sender: TransactionSigner;
  uniqueMessageAccount: TransactionSigner;
  mailbox: Address;
  data: TransferRemoteToInstructionData;
  fee?: FeeTransferRemoteSection;
  igp?: IgpTransferRemoteSection;
  pluginAccounts: InstructionAccountMeta[];
}): Promise<Instruction> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(
    args.programAddress,
  );
  const { address: ccStatePda } = await deriveCrossCollateralStatePda(
    args.programAddress,
  );
  const { address: mailboxOutbox } = await deriveMailboxOutboxPda(args.mailbox);
  // Remote path shares the mailbox dispatch_authority PDA with the regular
  // transfer_remote (token-lib derives it via
  // mailbox_message_dispatch_authority_pda_seeds!()). The CC-specific
  // dispatch authority is only used on the local HandleLocal CPI path.
  const { address: dispatchAuthority } =
    await deriveMailboxDispatchAuthorityPda(args.programAddress);
  const { address: dispatchedMessagePda } =
    await deriveMailboxDispatchedMessagePda(
      args.mailbox,
      args.uniqueMessageAccount.address,
    );

  const accounts: InstructionAccountMeta[] = [
    readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    readonlyAccount(tokenPda),
    readonlyAccount(ccStatePda),
    readonlyAccount(SPL_NOOP_PROGRAM_ADDRESS),
    readonlyAccount(args.mailbox),
    writableAccount(mailboxOutbox),
    readonlyAccount(dispatchAuthority),
    writableSigner(args.sender),
    readonlySigner(args.uniqueMessageAccount),
    writableAccount(dispatchedMessagePda),
    ...(args.fee ? buildFeeTransferRemoteSectionAccounts(args.fee) : []),
    ...(args.igp
      ? buildIgpTransferRemoteSectionAccounts(args.igp, args.programAddress)
      : []),
    ...args.pluginAccounts,
  ];

  return buildInstruction(
    args.programAddress,
    accounts,
    concatBytes(
      CC_INSTRUCTION_DISCRIMINATOR,
      u8(CrossCollateralInstructionKind.TransferRemoteTo),
      encodeTransferRemoteTo(args.data),
    ),
  );
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
