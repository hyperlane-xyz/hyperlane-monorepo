import {
  Connection,
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import { SealevelCoreAdapter } from '@hyperlane-xyz/sdk';
import { ensure0x, messageId, parseMessage } from '@hyperlane-xyz/utils';

export const DISPATCHED_MESSAGE_DISCRIMINATOR = Buffer.from('DISPATCH');
export const DISPATCHED_MESSAGE_HEADER_SIZE = 8 + 4 + 8 + 32;

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
  if (data.length <= DISPATCHED_MESSAGE_HEADER_SIZE) return null;
  const discriminator = data.subarray(0, 8);
  if (!discriminator.equals(DISPATCHED_MESSAGE_DISCRIMINATOR)) return null;
  const encodedMessage = ensure0x(
    data.subarray(DISPATCHED_MESSAGE_HEADER_SIZE).toString('hex'),
  );
  if (
    messageId(encodedMessage).toLowerCase() !== expectedMessageId.toLowerCase()
  ) {
    return null;
  }
  const parsed = parseMessage(encodedMessage);
  if (parsed.destination !== expectedDestinationDomain) return null;
  return encodedMessage;
}

export async function extractRawMessage(
  connection: Connection,
  mailboxProgramId: PublicKey,
  tx: VersionedTransactionResponse,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): Promise<string | null> {
  for (const key of getCandidateKeys(tx)) {
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
  return null;
}
