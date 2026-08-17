import {
  type Address,
  type AddressesByLookupTableAddress,
  type Base64EncodedWireTransaction,
  type Commitment,
  type GetSignatureStatusesApi,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
  type TransactionSigner,
  type partiallySignTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  assertIsSignature,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
} from '@solana/kit';
import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
} from '@solana/errors';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  assert,
  concurrentMap,
  isNullish,
  type Logger,
  pollAsync,
  sleep,
  strip0x,
} from '@hyperlane-xyz/utils';

import { fetchAddressLookupTableState } from '../accounts/address-lookup-table.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';
import {
  convertLegacySolanaTransaction,
  isLegacySolanaTransaction,
} from '../legacy-compat.js';
import { createRpc } from '../rpc.js';
import {
  buildTransactionMessage,
  serializeUnsignedTransaction,
} from '../tx.js';
import type {
  AnnotatedSvmTransaction,
  PrintableSvmTransaction,
  SendableSvmTransaction,
  SvmReceipt,
  SvmRpc,
  SvmTransaction,
  WithExtraSigners,
} from '../types.js';

import { SvmProvider } from './provider.js';

/**
 * Signing strategy injected into the shared submission pipeline. A live signer
 * passes kit's fully-signing variant; an impersonating signer passes the
 * partially-signing variant so it can submit transactions whose remaining
 * required signers it does not hold (relying on a fork's skip-signature
 * verification). Typed as the partial variant because its looser (not
 * fully-signed) return type is the common supertype both variants satisfy.
 */
export type SignTransactionMessage =
  typeof partiallySignTransactionMessageWithSigners;

/**
 * Serializes a transaction into the Squads-compatible printable JSON used by
 * the file / offline-signing submitter. `feePayerAddress` is the account to
 * encode as fee payer when the transaction does not carry one.
 */
export async function buildPrintableTransaction(
  rpc: SvmRpc,
  feePayerAddress: Address,
  transaction: AnnotatedSvmTransaction,
): Promise<PrintableSvmTransaction> {
  const resolvedAlts = await resolveAddressLookupTables(
    rpc,
    transaction.addressLookupTables,
  );
  const { transactionBase58, messageBase58 } = serializeUnsignedTransaction(
    transaction.instructions,
    transaction.feePayer ?? feePayerAddress,
    resolvedAlts,
  );

  return {
    annotation: transaction.annotation,
    instructions: transaction.instructions.map((ix) => ({
      programAddress: ix.programAddress,
      accounts: ix.accounts,
      data: ix.data ? Buffer.from(ix.data).toString('hex') : undefined,
    })),
    computeUnits: transaction.computeUnits,
    transaction_base58: transactionBase58,
    message_base58: messageBase58,
    waitForSlotAdvance: transaction.waitForSlotAdvance,
  };
}

type SignatureStatusResponse = Awaited<
  ReturnType<GetSignatureStatusesApi['getSignatureStatuses']>
>['value'][0];

export class SvmTransactionError extends Error {
  constructor(signature: string, cause: unknown) {
    super(
      `Transaction failed: ${signature}, err: ${JSON.stringify(cause, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
    this.name = 'SvmTransactionError';
    this.cause = cause;
  }
}

const base58Encoder = getBase58Encoder();

function parseKeyBytes(privateKey: string): ReadonlyUint8Array {
  // Try hex (32 bytes = 64 hex chars, 64 bytes = 128 hex chars)
  const stripped = strip0x(privateKey);
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  }
  if (/^[0-9a-fA-F]{128}$/.test(stripped)) {
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  }

  // Try base58
  let keyBytes: ReadonlyUint8Array;
  try {
    keyBytes = base58Encoder.encode(privateKey);
  } catch (err) {
    throw new Error(
      `Failed to parse private key. Expected hex (64 or 128 chars) or base58. ` +
        `Base58 error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (keyBytes.length !== 32 && keyBytes.length !== 64) {
    throw new Error(
      `Base58-decoded key has invalid length: ${keyBytes.length}. Expected 32 (private key) or 64 (keypair).`,
    );
  }
  return keyBytes;
}

/** Parses a hex or base58 private key / keypair into a kit `KeyPairSigner`. */
export async function createKeypairFromPrivateKey(
  privateKey: string,
): Promise<KeyPairSigner> {
  const keyBytes = parseKeyBytes(privateKey);
  if (keyBytes.length === 32) {
    return createKeyPairSignerFromPrivateKeyBytes(keyBytes);
  }
  if (keyBytes.length === 64) {
    return createKeyPairSignerFromBytes(keyBytes);
  }
  throw new Error(
    `Invalid key length: ${keyBytes.length}. Expected 32 (private key) or 64 (keypair).`,
  );
}

export const RPC_COMMITMENT_LEVEL: Commitment = 'confirmed';

/** Cap on parallel RPC fetches when resolving ALT addresses → on-chain state. */
const RESOLVE_ALT_CONCURRENCY = 4;

/**
 * Detects blockhash-not-found errors from sendTransaction.
 * The RPC wraps it as a preflight failure (-32002) with the
 * BlockhashNotFound error as its cause.
 */
function isBlockhashNotFoundError(error: unknown): boolean {
  if (
    isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)
  ) {
    return true;
  }

  if (
    isSolanaError(
      error,
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    )
  ) {
    return isSolanaError(
      error.cause,
      SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
    );
  }

  return false;
}

type HistoryCheckResult =
  | { confirmed: true; slot: bigint }
  | { confirmed: false }
  | null;

/**
 * Fetches each ALT's on-chain entries and assembles the
 * `AddressesByLookupTableAddress` map kit's compiler expects. Callers
 * only need to know the ALT pubkeys; the contents are pulled from
 * on-chain state so the local SDK can't drift from what the v0
 * compiler / on-chain runtime would resolve.
 */
export async function resolveAddressLookupTables(
  rpc: SvmRpc,
  altAddresses: Address[] | undefined,
): Promise<AddressesByLookupTableAddress | undefined> {
  if (!altAddresses?.length) return undefined;
  const entries = await concurrentMap(
    RESOLVE_ALT_CONCURRENCY,
    altAddresses,
    async (address) => {
      const state = await fetchAddressLookupTableState(rpc, address);
      return [address, state.addresses] as const;
    },
  );
  return Object.fromEntries(entries);
}

/**
 * Builds, signs, and sends a transaction with a confirmed blockhash.
 * Retries on blockhash-not-found errors with backoff to handle
 * load-balanced RPC node desync. The `signMessage` strategy selects
 * full vs partial signing.
 */
async function signAndSend(params: {
  rpc: SvmRpc;
  feePayer: TransactionSigner;
  tx: SendableSvmTransaction;
  logger: Logger;
  signMessage: SignTransactionMessage;
  skipPreflight?: boolean;
  maxAttempts?: number;
}): Promise<{
  signature: Signature;
  rawTx: Base64EncodedWireTransaction;
  lastValidBlockHeight: bigint;
}> {
  const {
    rpc,
    feePayer,
    tx,
    logger,
    signMessage,
    skipPreflight,
    maxAttempts = 5,
  } = params;
  const resolvedAlts = await resolveAddressLookupTables(
    rpc,
    tx.addressLookupTables,
  );

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash({ commitment: RPC_COMMITMENT_LEVEL })
      .send();

    let txMessage = buildTransactionMessage({
      instructions: tx.instructions,
      feePayer,
      recentBlockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      computeUnits: tx.computeUnits ?? DEFAULT_COMPUTE_UNITS,
      addressLookupTables: resolvedAlts,
    });

    if (tx.additionalSigners?.length) {
      txMessage = addSignersToTransactionMessage(
        tx.additionalSigners,
        txMessage,
      );
    }

    const signedTx = await signMessage(txMessage);
    const signature = getSignatureFromTransaction(signedTx);

    try {
      const rawTx = getBase64EncodedWireTransaction(signedTx);
      await rpc
        .sendTransaction(rawTx, {
          encoding: 'base64',
          skipPreflight: skipPreflight ?? tx.skipPreflight ?? false,
          // Set to 0 to avoid conflicts between the rpc/provider
          // retrying and the signer as it tracks and retries
          // pending txs manually
          maxRetries: 0n,
          preflightCommitment: RPC_COMMITMENT_LEVEL,
        })
        .send();

      return {
        signature,
        rawTx,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };
    } catch (error) {
      if (isBlockhashNotFoundError(error) && attempt < maxAttempts - 1) {
        const delay = 500 * (attempt + 1);
        logger.debug(
          `Blockhash not found on attempt ${attempt + 1}, retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      // Surface the on-chain program logs from a failed preflight so the
      // caller sees why the transaction reverted, not just "simulation
      // failed" (e.g. insufficient lamports, custom program errors).
      if (
        isSolanaError(
          error,
          SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
        )
      ) {
        const { logs } = error.context;
        if (logs?.length) {
          logger.error(
            `Transaction ${signature} simulation failed:\n${logs.join('\n')}`,
          );
        }
      }

      throw error;
    }
  }
  // Unreachable: the loop always either returns or throws
  throw new Error('signAndSend: unreachable');
}

/**
 * Evaluates a signature status result. Throws on error, returns
 * `{ confirmed: true, slot }` if confirmed/finalized, `{ confirmed: false }`
 * if still progressing, or `null` if the signature was not found.
 */
function checkSignatureResult(
  signature: Signature,
  result: SignatureStatusResponse,
): HistoryCheckResult {
  if (!result) return null;

  if (result.err) {
    throw new SvmTransactionError(signature, result.err);
  }

  if (
    result.confirmationStatus === RPC_COMMITMENT_LEVEL ||
    result.confirmationStatus === 'finalized'
  ) {
    return { confirmed: true, slot: result.slot };
  }

  return { confirmed: false };
}

/**
 * Honors the `waitForSlotAdvance` delivery hint: blocks until the cluster
 * slot advances past the slot the transaction confirmed in, so the caller's
 * next transaction executes in a strictly later slot.
 */
async function awaitSlotAdvance(
  rpc: SvmRpc,
  tx: SendableSvmTransaction,
  receipt: SvmReceipt,
): Promise<void> {
  if (!tx.waitForSlotAdvance || isNullish(receipt.slot)) {
    return;
  }

  const confirmedSlot = receipt.slot;
  await pollAsync(
    async () => {
      const slot = await rpc
        .getSlot({ commitment: RPC_COMMITMENT_LEVEL })
        .send();
      assert(
        slot > confirmedSlot,
        `slot ${slot} has not advanced past ${confirmedSlot}`,
      );
    },
    500,
    60,
  );
}

/**
 * Polls getSignatureStatuses while the blockhash is still valid.
 * Rebroadcasts the same signed tx periodically (fire-and-forget).
 * Returns the receipt if confirmed, or null if the blockhash expired.
 */
async function pollForConfirmation(params: {
  rpc: SvmRpc;
  logger: Logger;
  signature: Signature;
  rawTx: Base64EncodedWireTransaction;
  lastValidBlockHeight: bigint;
  pollIntervalMs: number;
}): Promise<SvmReceipt | null> {
  const {
    rpc,
    logger,
    signature,
    rawTx,
    lastValidBlockHeight,
    pollIntervalMs,
  } = params;
  const maxBlockHeightFailures = 3;
  const wallClockDeadline = Date.now() + 2 * 60 * 1000;
  let blockHeightFailures = 0;
  let delay = Math.max(Math.floor(pollIntervalMs / 4), 250);

  while (Date.now() < wallClockDeadline) {
    await sleep(delay);
    delay = Math.min(Math.floor(delay * 1.5), pollIntervalMs);

    // Check confirmation status
    try {
      const status = await rpc.getSignatureStatuses([signature]).send();
      const check = checkSignatureResult(signature, status.value[0]);

      if (check?.confirmed) {
        return { signature, slot: check.slot };
      }

      // Transaction seen (e.g. 'processed') — keep polling, don't rebroadcast
      if (check) continue;
    } catch (error) {
      if (error instanceof SvmTransactionError) throw error;
      logger.debug('Status poll failed', { error });
    }

    // Check if blockhash expired
    try {
      const currentBlockHeight = await rpc
        .getBlockHeight({ commitment: RPC_COMMITMENT_LEVEL })
        .send();

      // Reset on successful fetch
      blockHeightFailures = 0;
      if (currentBlockHeight > lastValidBlockHeight) {
        return null;
      }
    } catch (error) {
      blockHeightFailures++;
      logger.debug('Block height check failed', { error });
      if (blockHeightFailures >= maxBlockHeightFailures) {
        logger.warn(
          `Block height check failed ${maxBlockHeightFailures} times, treating as expired`,
        );
        return null;
      }
    }

    // Rebroadcast same signed tx (fire-and-forget, always skip preflight)
    try {
      await rpc
        .sendTransaction(rawTx, {
          encoding: 'base64',
          skipPreflight: true,
          maxRetries: 0n,
        })
        .send();
    } catch (error) {
      logger.debug('Rebroadcast failed', { error, signature });
    }
  }

  // Wall-clock timeout exceeded — tx fate unknown, unsafe to resubmit
  throw new Error(
    `Poll timeout exceeded for ${signature}, aborting to prevent potential double-execution`,
  );
}

/**
 * Signs and sends a transaction, then polls for confirmation. On blockhash
 * expiry, checks transaction history before resubmitting to prevent
 * double-execution. The `signMessage` strategy selects full vs partial signing.
 */
export async function sendWithConfirmation(params: {
  rpc: SvmRpc;
  feePayer: TransactionSigner;
  tx: SendableSvmTransaction;
  logger: Logger;
  signMessage: SignTransactionMessage;
  skipPreflight?: boolean;
}): Promise<SvmReceipt> {
  const { rpc, feePayer, tx, logger, signMessage, skipPreflight } = params;
  const maxBlockhashAttempts = 3;
  const pollIntervalMs = 2000;

  let lastSignature: string | undefined;
  for (
    let blockhashAttempt = 0;
    blockhashAttempt < maxBlockhashAttempts;
    blockhashAttempt++
  ) {
    const { signature, rawTx, lastValidBlockHeight } = await signAndSend({
      rpc,
      feePayer,
      tx,
      logger,
      signMessage,
      skipPreflight,
    });
    lastSignature = signature;

    // Poll while blockhash is valid
    const result = await pollForConfirmation({
      rpc,
      logger,
      signature,
      rawTx,
      lastValidBlockHeight,
      pollIntervalMs,
    });
    if (result) {
      await awaitSlotAdvance(rpc, tx, result);
      return result;
    }

    // Blockhash expired — check history before resubmitting
    let historyCheck: HistoryCheckResult = null;
    try {
      const historyStatus = await rpc
        .getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
        .send();

      historyCheck = checkSignatureResult(signature, historyStatus.value[0]);
    } catch (error) {
      if (error instanceof SvmTransactionError) throw error;

      throw new Error(
        `Cannot safely resubmit: history lookup failed for ${signature}, aborting to prevent double-execution.`,
        { cause: error },
      );
    }

    if (historyCheck?.confirmed) {
      const receipt = { signature, slot: historyCheck.slot };
      await awaitSlotAdvance(rpc, tx, receipt);
      return receipt;
    }

    if (historyCheck) {
      // Tx still progressing (e.g. 'processed') — keep polling same
      // signature with a fresh block height ceiling
      const { value: freshBlockhash } = await rpc
        .getLatestBlockhash({ commitment: RPC_COMMITMENT_LEVEL })
        .send();

      const retry = await pollForConfirmation({
        rpc,
        logger,
        signature,
        rawTx,
        lastValidBlockHeight: freshBlockhash.lastValidBlockHeight,
        pollIntervalMs,
      });

      if (retry) {
        await awaitSlotAdvance(rpc, tx, retry);
        return retry;
      }

      throw new Error(
        `Transaction ${signature} was observed at 'processed' but never confirmed`,
      );
    }

    if (blockhashAttempt < maxBlockhashAttempts - 1) {
      logger.debug(
        `Blockhash expired and tx not found, resubmitting (attempt ${blockhashAttempt + 2}/${maxBlockhashAttempts})`,
      );
    }
  }

  throw new Error(
    `Transaction not confirmed after ${maxBlockhashAttempts} blockhash attempts (last signature: ${lastSignature})`,
  );
}

/**
 * Fetches full transaction to populate meta (including logs) on the receipt.
 * Retries with backoff since RPC indexing can lag behind confirmation.
 * // TODO: make meta-fetch opt-in once the legacy compat layer is removed
 */
export async function fetchTransactionMeta(
  rpc: SvmRpc,
  logger: Logger,
  receipt: SvmReceipt,
  maxRetries = 5,
): Promise<SvmReceipt> {
  assertIsSignature(receipt.signature);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const fullTx = await rpc
        .getTransaction(receipt.signature, {
          commitment: RPC_COMMITMENT_LEVEL,
          maxSupportedTransactionVersion: 0,
          encoding: 'jsonParsed',
        })
        .send();

      if (fullTx?.meta?.logMessages) {
        return {
          ...receipt,
          meta: { logMessages: fullTx.meta.logMessages },
        };
      }
    } catch (error) {
      logger.debug(`Attempt ${attempt + 1} failed to fetch tx meta`, {
        error,
      });
    }

    if (attempt < maxRetries - 1) {
      await sleep(1000 * (attempt + 1));
    }
  }

  logger.warn('Transaction meta unavailable after retries', {
    signature: receipt.signature,
  });
  return receipt;
}

/**
 * Shared base for the live and impersonating Sealevel signers. Holds the fee
 * payer, the printable-JSON serialization, and the send / confirm pipeline.
 * Subclasses supply two override points: `signMessage` selects full vs partial
 * signing, and `skipPreflight` optionally forces preflight to be skipped.
 */
export abstract class BaseSvmSigner
  extends SvmProvider
  implements AltVM.ISigner<SvmTransaction, SvmReceipt>
{
  readonly signer: TransactionSigner;
  protected abstract readonly logger: Logger;

  /** Kit signing variant selecting full vs partial signing. */
  protected abstract readonly signMessage: SignTransactionMessage;

  /**
   * Forces `skipPreflight` on submission. Left undefined by the live signer so
   * the per-transaction `skipPreflight` hint is honored; the impersonating
   * signer forces it true because preflight verifies signatures it lacks.
   */
  protected readonly skipPreflight?: boolean;

  protected constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigner,
  ) {
    super(rpc, rpcUrls, chainMetadata);
    this.signer = signer;
  }

  /**
   * Resolves the shared connection inputs (RPC + parsed keypair) both concrete
   * signers construct from. Kept protected so each subclass's
   * `connectWithSigner` returns its own concrete type.
   */
  protected static async resolveConnection(
    metadata: ChainMetadataForAltVM,
    privateKey: string,
  ): Promise<{
    rpc: SvmRpc;
    rpcUrls: string[];
    keypair: KeyPairSigner;
  }> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    const keypair = await createKeypairFromPrivateKey(privateKey);

    return { rpc, rpcUrls, keypair };
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: AnnotatedSvmTransaction,
  ): Promise<PrintableSvmTransaction> {
    return buildPrintableTransaction(
      this.rpc,
      this.signer.address,
      transaction,
    );
  }

  async send(tx: SendableSvmTransaction): Promise<SvmReceipt> {
    return sendWithConfirmation({
      rpc: this.rpc,
      feePayer: this.signer,
      tx,
      logger: this.logger,
      signMessage: this.signMessage,
      skipPreflight: this.skipPreflight,
    });
  }

  async sendAndConfirmTransaction(
    transaction: WithExtraSigners<SendableSvmTransaction>,
  ): Promise<SvmReceipt> {
    const tx = isLegacySolanaTransaction(transaction)
      ? await convertLegacySolanaTransaction(
          transaction,
          transaction.extraSigners,
        )
      : transaction;

    const receipt = await this.send(tx);
    return fetchTransactionMeta(this.rpc, this.logger, receipt);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: SendableSvmTransaction[],
  ): Promise<SvmReceipt> {
    throw new Error('Sealevel does not support transaction batching');
  }
}
