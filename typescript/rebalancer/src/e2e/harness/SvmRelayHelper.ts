import { ethers } from 'ethers';
import {
  Connection,
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Logger } from 'pino';

import {
  HyperlaneCore,
  type MultiProvider,
  SealevelCoreAdapter,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  ensure0x,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

export interface SvmToEvmRelayOpts {
  connection: Connection;
  mailboxProgramId: PublicKey;
  evmCore: HyperlaneCore;
  multiProvider: MultiProvider;
  logger: Logger;
}

const DISPATCHED_MESSAGE_DISCRIMINATOR = Buffer.from('DISPATCH');
const DISPATCHED_MESSAGE_HEADER_SIZE = 8 + 4 + 8 + 32;

export async function relaySvmToEvmMessages(
  opts: SvmToEvmRelayOpts,
): Promise<number> {
  const signatures = await opts.connection.getSignaturesForAddress(
    opts.mailboxProgramId,
    { limit: 100 },
  );

  const seen = new Set<string>();
  let relayedCount = 0;
  const failures: string[] = [];

  for (const sig of signatures) {
    if (sig.err) continue;

    const tx = await opts.connection.getTransaction(sig.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    const dispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      tx.meta?.logMessages ?? [],
    );

    for (const dispatch of dispatches) {
      const destinationDomain = Number.parseInt(dispatch.destination, 10);
      if (!Number.isFinite(destinationDomain)) continue;

      const target = resolveTarget(opts, destinationDomain);
      if (!target) continue;

      const id = ensure0x(dispatch.messageId).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        await relaySingle(
          opts,
          tx,
          sig.signature,
          id,
          destinationDomain,
          target,
        );
        relayedCount++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`[${id}] ${target.chain} tx=${sig.signature}: ${reason}`);
      }
    }
  }

  if (failures.length) {
    throw new Error(
      `Failed relaying ${failures.length} SVM->EVM message(s): ${failures.join(' | ')}`,
    );
  }

  return relayedCount;
}

function resolveTarget(
  opts: SvmToEvmRelayOpts,
  destinationDomain: number,
): { chain: string; mailbox: ethers.Contract } | null {
  const chain = opts.multiProvider.tryGetChainName(destinationDomain);
  if (!chain) return null;
  if (opts.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum)
    return null;

  return {
    chain,
    mailbox: opts.evmCore
      .getContracts(chain)
      .mailbox.connect(opts.multiProvider.getSigner(chain)),
  };
}

async function relaySingle(
  opts: SvmToEvmRelayOpts,
  svmTx: VersionedTransactionResponse,
  signature: string,
  messageIdHex: string,
  destinationDomain: number,
  target: { chain: string; mailbox: ethers.Contract },
): Promise<void> {
  if (await target.mailbox.delivered(messageIdHex)) return;

  const message = await extractRawMessage(
    opts,
    svmTx,
    messageIdHex,
    destinationDomain,
  );

  if (!message) {
    throw new Error(
      `Unable to reconstruct raw message bytes for ${messageIdHex}; cannot call mailbox.process`,
    );
  }

  const relayTx = await target.mailbox.process('0x', message, {
    gasLimit: 500_000,
  });
  await relayTx.wait();

  if (!(await target.mailbox.delivered(messageIdHex))) {
    throw new Error(
      `mailbox.process confirmed but message ${messageIdHex} is not marked delivered`,
    );
  }

  opts.logger.debug(
    { messageId: messageIdHex, destinationChain: target.chain, signature },
    'Relayed SVM-origin message to EVM mailbox',
  );
}

async function extractRawMessage(
  opts: SvmToEvmRelayOpts,
  tx: VersionedTransactionResponse,
  expectedMessageId: string,
  expectedDestinationDomain: number,
): Promise<string | null> {
  for (const key of getCandidateKeys(tx)) {
    const pda = SealevelCoreAdapter.deriveMailboxDispatchedMessagePda(
      opts.mailboxProgramId,
      key,
    );

    const accountInfo = await opts.connection.getAccountInfo(pda, 'confirmed');
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

function parseDispatchedMessageAccount(
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

function getCandidateKeys(tx: VersionedTransactionResponse): PublicKey[] {
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
