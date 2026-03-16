import {
  Connection,
  PublicKeyInitData,
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
  SEALEVEL_SPL_NOOP_ADDRESS,
  SealevelCoreAdapter,
} from '@hyperlane-xyz/sdk';
import { ensure0x, messageId, parseMessage } from '@hyperlane-xyz/utils';

export const DISPATCHED_MESSAGE_DISCRIMINATOR = Buffer.from('DISPATCH');
export const DISPATCHED_MESSAGE_HEADER_SIZE = 8 + 4 + 8 + 32;
export const ACCOUNT_DATA_INITIALIZED_PREFIX_SIZE = 1;
const SPL_NOOP_PROGRAM_ID = new PublicKey(SEALEVEL_SPL_NOOP_ADDRESS);

type EncodedInstruction = {
  data: string;
  programIdIndex: number;
};

function toPublicKey(key: PublicKeyInitData): PublicKey {
  return key instanceof PublicKey ? key : new PublicKey(key);
}

function getOrderedAccountKeys(tx: VersionedTransactionResponse): PublicKey[] {
  const message = tx.transaction.message as {
    staticAccountKeys?: ReadonlyArray<PublicKeyInitData>;
    accountKeys?: ReadonlyArray<PublicKeyInitData>;
  };

  if (message.staticAccountKeys?.length) {
    const loadedWritable = tx.meta?.loadedAddresses?.writable ?? [];
    const loadedReadonly = tx.meta?.loadedAddresses?.readonly ?? [];
    return [
      ...message.staticAccountKeys.map(toPublicKey),
      ...loadedWritable.map((key) => new PublicKey(key)),
      ...loadedReadonly.map((key) => new PublicKey(key)),
    ];
  }

  return (message.accountKeys ?? []).map(toPublicKey);
}

function maybeEncodedInstruction(value: unknown): EncodedInstruction | null {
  if (!value || typeof value !== 'object') return null;
  const maybeData = (value as { data?: unknown }).data;
  const maybeProgramIdIndex = (value as { programIdIndex?: unknown })
    .programIdIndex;
  if (typeof maybeData !== 'string') return null;
  if (typeof maybeProgramIdIndex !== 'number') return null;
  return { data: maybeData, programIdIndex: maybeProgramIdIndex };
}

function getEncodedInstructions(
  tx: VersionedTransactionResponse,
): EncodedInstruction[] {
  const message = tx.transaction.message as {
    compiledInstructions?: unknown[];
    instructions?: unknown[];
  };
  const instructions: EncodedInstruction[] = [];

  for (const instruction of message.compiledInstructions ?? []) {
    const encoded = maybeEncodedInstruction(instruction);
    if (encoded) instructions.push(encoded);
  }
  for (const instruction of message.instructions ?? []) {
    const encoded = maybeEncodedInstruction(instruction);
    if (encoded) instructions.push(encoded);
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    const innerInstructions = (inner as { instructions?: unknown[] })
      .instructions;
    if (!innerInstructions?.length) continue;
    for (const instruction of innerInstructions) {
      const encoded = maybeEncodedInstruction(instruction);
      if (encoded) instructions.push(encoded);
    }
  }

  return instructions;
}

function extractRawMessageFromNoopInstructionData(
  tx: VersionedTransactionResponse,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): string | null {
  const accountKeys = getOrderedAccountKeys(tx);
  for (const instruction of getEncodedInstructions(tx)) {
    const programId = accountKeys[instruction.programIdIndex];
    if (!programId || !programId.equals(SPL_NOOP_PROGRAM_ID)) continue;

    const data = Buffer.from(bs58.decode(instruction.data));
    const maybeMessage = parseDispatchedMessageAccount(
      data,
      expectedMessageId,
      expectedDestinationDomain,
    );
    if (maybeMessage) return maybeMessage;
  }
  return null;
}

function extractRawMessageFromProgramDataLogs(
  tx: VersionedTransactionResponse,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): string | null {
  for (const log of tx.meta?.logMessages ?? []) {
    if (!log.startsWith('Program data: ')) continue;
    const encoded = log.slice('Program data: '.length).trim();
    if (!encoded) continue;
    let data: Buffer;
    try {
      data = Buffer.from(encoded, 'base64');
    } catch {
      continue;
    }
    const maybeMessage = parseDispatchedMessageAccount(
      data,
      expectedMessageId,
      expectedDestinationDomain,
    );
    if (maybeMessage) return maybeMessage;
  }
  return null;
}

export function getCandidateKeys(
  tx: VersionedTransactionResponse,
): PublicKey[] {
  const keys = new Map<string, PublicKey>();
  const message = tx.transaction.message as {
    staticAccountKeys?: ReadonlyArray<PublicKey>;
    accountKeys?: ReadonlyArray<PublicKey>;
  };
  for (const key of message.staticAccountKeys ?? []) {
    keys.set(key.toBase58(), key);
  }
  for (const key of message.accountKeys ?? []) {
    keys.set(key.toBase58(), key);
  }
  for (const key of tx.meta?.loadedAddresses?.readonly ?? []) {
    const pubkey = new PublicKey(key);
    keys.set(pubkey.toBase58(), pubkey);
  }
  for (const key of tx.meta?.loadedAddresses?.writable ?? []) {
    const pubkey = new PublicKey(key);
    keys.set(pubkey.toBase58(), pubkey);
  }
  return [...keys.values()];
}

export function parseDispatchedMessageAccount(
  data: Buffer,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): string | null {
  const candidateOffsets = [0, ACCOUNT_DATA_INITIALIZED_PREFIX_SIZE];

  for (const offset of candidateOffsets) {
    if (data.length <= offset + DISPATCHED_MESSAGE_HEADER_SIZE) continue;
    const discriminator = data.subarray(offset, offset + 8);
    if (!discriminator.equals(DISPATCHED_MESSAGE_DISCRIMINATOR)) continue;

    const encodedMessage = ensure0x(
      data.subarray(offset + DISPATCHED_MESSAGE_HEADER_SIZE).toString('hex'),
    );
    if (
      messageId(encodedMessage).toLowerCase() !==
      expectedMessageId.toLowerCase()
    ) {
      continue;
    }
    const parsed = parseMessage(encodedMessage);
    if (parsed.destination !== expectedDestinationDomain) continue;
    return encodedMessage;
  }

  return null;
}

export async function extractRawMessage(
  connection: Connection,
  mailboxProgramId: PublicKey,
  tx: VersionedTransactionResponse,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): Promise<string | null> {
  const fromProgramDataLogs = extractRawMessageFromProgramDataLogs(
    tx,
    expectedMessageId,
    expectedDestinationDomain,
  );
  if (fromProgramDataLogs) return fromProgramDataLogs;

  const fromNoopData = extractRawMessageFromNoopInstructionData(
    tx,
    expectedMessageId,
    expectedDestinationDomain,
  );
  if (fromNoopData) return fromNoopData;

  for (const key of getCandidateKeys(tx)) {
    const directAccountInfo = await connection.getAccountInfo(key, 'confirmed');
    if (directAccountInfo?.data) {
      const directMessage = parseDispatchedMessageAccount(
        Buffer.from(directAccountInfo.data),
        expectedMessageId,
        expectedDestinationDomain,
      );
      if (directMessage) return directMessage;
    }

    const pda = SealevelCoreAdapter.deriveMailboxDispatchedMessagePda(
      mailboxProgramId,
      key,
    );
    const accountInfo = await connection.getAccountInfo(pda, 'confirmed');
    if (!accountInfo?.data) continue;
    const maybeMessage = parseDispatchedMessageAccount(
      Buffer.from(accountInfo.data),
      expectedMessageId,
      expectedDestinationDomain,
    );
    if (maybeMessage) return maybeMessage;
  }

  const mailboxAccounts = await connection.getProgramAccounts(
    mailboxProgramId,
    {
      commitment: 'confirmed',
    },
  );
  for (const account of mailboxAccounts) {
    const maybeMessage = parseDispatchedMessageAccount(
      Buffer.from(account.account.data),
      expectedMessageId,
      expectedDestinationDomain,
    );
    if (maybeMessage) return maybeMessage;
  }

  return null;
}
