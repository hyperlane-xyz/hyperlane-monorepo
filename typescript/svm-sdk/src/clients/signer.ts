import {
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
  type TransactionSigner,
  type GetSignatureStatusesApi,
  addSignersToTransactionMessage,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Commitment,
} from '@solana/kit';
import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
} from '@solana/errors';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, rootLogger, sleep, strip0x } from '@hyperlane-xyz/utils';
import type { InstructionAccountMeta } from '../instructions/utils.js';

import { createRpc } from '../rpc.js';
import {
  type Web3KeypairLike,
  type Web3TransactionLike,
  buildTransactionMessage,
  normalizeTransaction,
  serializeUnsignedTransaction,
} from '../tx.js';
import type {
  AnnotatedSvmTransaction,
  SvmReceipt,
  SvmRpc,
  SvmTransaction,
} from '../types.js';

import { SvmProvider } from './provider.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';

type SendableSvmTransaction = Omit<SvmTransaction, 'feePayer'>;
type SendableSvmCompatTransaction = SvmTransaction | Web3TransactionLike;
type SendableSvmExtraSignerTransaction = SendableSvmCompatTransaction & {
  extraSigners?: readonly (TransactionSigner | Web3KeypairLike)[];
};
type AnnotatedSvmCompatTransaction =
  | AnnotatedSvmTransaction
  | (Web3TransactionLike & { annotation?: string });

/** Shape returned by `transactionToPrintableJson`. */
export interface PrintableSvmTransaction {
  annotation?: string;
  instructions: PrintableSvmInstruction[];
  computeUnits?: number;
  transaction_base58: string;
  message_base58: string;
}

export interface PrintableSvmInstruction {
  programAddress: Address;
  accounts?: readonly InstructionAccountMeta[];
  data?: string;
}

type SignatureStatusResponse = Awaited<
  ReturnType<GetSignatureStatusesApi['getSignatureStatuses']>
>['value'][0];

class SvmTransactionError extends Error {
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

const RPC_COMMITMENT_LEVEL: Commitment = 'confirmed';

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

function isWeb3KeypairLike(value: unknown): value is Web3KeypairLike {
  return (
    !!value &&
    typeof value === 'object' &&
    'publicKey' in value &&
    'secretKey' in value
  );
}

async function normalizeAdditionalSigners(
  signers?: readonly (TransactionSigner | Web3KeypairLike)[],
): Promise<TransactionSigner[] | undefined> {
  if (!signers?.length) return undefined;

  return Promise.all(
    signers.map((signer) =>
      isWeb3KeypairLike(signer)
        ? createKeyPairSignerFromBytes(signer.secretKey)
        : signer,
    ),
  );
}

type HistoryCheckResult =
  | { confirmed: true; slot: bigint }
  | { confirmed: false }
  | null;

export class SvmSigner
  extends SvmProvider
  implements AltVM.ISigner<SvmTransaction, SvmReceipt>
{
  readonly signer: TransactionSigner;
  private readonly logger = rootLogger.child({ module: 'SvmSigner' });

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    signer: TransactionSigner,
  ) {
    super(rpc, rpcUrls);
    this.signer = signer;
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    _extraParams?: Record<string, any>,
  ): Promise<SvmSigner> {
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    const keyBytes = parseKeyBytes(privateKey);

    let keypair: KeyPairSigner;
    if (keyBytes.length === 32) {
      keypair = await createKeyPairSignerFromPrivateKeyBytes(keyBytes);
    } else if (keyBytes.length === 64) {
      keypair = await createKeyPairSignerFromBytes(keyBytes);
    } else {
      throw new Error(
        `Invalid key length: ${keyBytes.length}. Expected 32 (private key) or 64 (keypair).`,
      );
    }

    return new SvmSigner(rpc, rpcUrls, keypair);
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: AnnotatedSvmCompatTransaction,
  ): Promise<PrintableSvmTransaction> {
    const normalizedTransaction = normalizeTransaction(transaction);
    const { transactionBase58, messageBase58 } = serializeUnsignedTransaction(
      normalizedTransaction.instructions,
      normalizedTransaction.feePayer ?? this.signer.address,
    );

    return {
      annotation: transaction.annotation,
      instructions: normalizedTransaction.instructions.map((ix) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data ? Buffer.from(ix.data).toString('hex') : undefined,
      })),
      computeUnits: normalizedTransaction.computeUnits,
      transaction_base58: transactionBase58,
      message_base58: messageBase58,
    };
  }

  /**
   * Builds, signs, and sends a transaction with a confirmed blockhash.
   * Retries on blockhash-not-found errors with backoff to handle
   * load-balanced RPC node desync.
   */
  private async signAndSend(
    tx: SendableSvmTransaction,
    maxAttempts = 5,
  ): Promise<{
    signature: Signature;
    rawTx: Base64EncodedWireTransaction;
    lastValidBlockHeight: bigint;
  }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { value: latestBlockhash } = await this.rpc
        .getLatestBlockhash({ commitment: RPC_COMMITMENT_LEVEL })
        .send();

      let txMessage = buildTransactionMessage({
        instructions: tx.instructions,
        feePayer: this.signer,
        recentBlockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        computeUnits: tx.computeUnits ?? DEFAULT_COMPUTE_UNITS,
      });

      if (tx.additionalSigners?.length) {
        txMessage = addSignersToTransactionMessage(
          tx.additionalSigners,
          txMessage,
        );
      }

      const signedTx = await signTransactionMessageWithSigners(txMessage);
      const signature = getSignatureFromTransaction(signedTx);

      try {
        const rawTx = getBase64EncodedWireTransaction(signedTx);
        await this.rpc
          .sendTransaction(rawTx, {
            encoding: 'base64',
            skipPreflight: tx.skipPreflight ?? false,
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
          this.logger.debug(
            `Blockhash not found on attempt ${attempt + 1}, retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
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
  private checkSignatureResult(
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
   * Sends a transaction and polls for confirmation. On blockhash expiry,
   * checks transaction history before resubmitting to prevent double-execution.
   */
  async send(tx: SendableSvmExtraSignerTransaction): Promise<SvmReceipt> {
    // Web3-shaped tx inputs can carry signer metadata outside the normalized
    // message fields. Convert those signers first, then rebuild a clean
    // SvmTransaction that can safely survive blockhash refresh and re-signing.
    const compatAdditionalSigners = await normalizeAdditionalSigners([
      ...(tx.additionalSigners ?? []),
      ...(tx.extraSigners ?? []),
    ]);
    const normalizedTx: SendableSvmTransaction = normalizeTransaction(tx);
    normalizedTx.additionalSigners = compatAdditionalSigners;
    const maxBlockhashAttempts = 3;
    const pollIntervalMs = 2000;

    let lastSignature: string | undefined;
    for (
      let blockhashAttempt = 0;
      blockhashAttempt < maxBlockhashAttempts;
      blockhashAttempt++
    ) {
      const { signature, rawTx, lastValidBlockHeight } =
        await this.signAndSend(normalizedTx);
      lastSignature = signature;

      // Poll while blockhash is valid
      const result = await this.pollForConfirmation(
        signature,
        rawTx,
        lastValidBlockHeight,
        pollIntervalMs,
      );
      if (result) {
        return result;
      }

      // Blockhash expired — check history before resubmitting
      let historyCheck: HistoryCheckResult = null;
      try {
        const historyStatus = await this.rpc
          .getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
          .send();

        historyCheck = this.checkSignatureResult(
          signature,
          historyStatus.value[0],
        );
      } catch (error) {
        if (error instanceof SvmTransactionError) throw error;

        throw new Error(
          `Cannot safely resubmit: history lookup failed for ${signature}, aborting to prevent double-execution.`,
          { cause: error },
        );
      }

      if (historyCheck?.confirmed) {
        return { signature, slot: historyCheck.slot };
      }

      if (historyCheck) {
        // Tx still progressing (e.g. 'processed') — keep polling same
        // signature with a fresh block height ceiling
        const { value: freshBlockhash } = await this.rpc
          .getLatestBlockhash({ commitment: RPC_COMMITMENT_LEVEL })
          .send();

        const retry = await this.pollForConfirmation(
          signature,
          rawTx,
          freshBlockhash.lastValidBlockHeight,
          pollIntervalMs,
        );

        if (retry) return retry;

        throw new Error(
          `Transaction ${signature} was observed at 'processed' but never confirmed`,
        );
      }

      if (blockhashAttempt < maxBlockhashAttempts - 1) {
        this.logger.debug(
          `Blockhash expired and tx not found, resubmitting (attempt ${blockhashAttempt + 2}/${maxBlockhashAttempts})`,
        );
      }
    }

    throw new Error(
      `Transaction not confirmed after ${maxBlockhashAttempts} blockhash attempts (last signature: ${lastSignature})`,
    );
  }

  /**
   * Polls getSignatureStatuses while the blockhash is still valid.
   * Rebroadcasts the same signed tx periodically (fire-and-forget).
   * Returns the receipt if confirmed, or null if the blockhash expired.
   */
  private async pollForConfirmation(
    signature: Signature,
    rawTx: Base64EncodedWireTransaction,
    lastValidBlockHeight: bigint,
    pollIntervalMs: number,
  ): Promise<SvmReceipt | null> {
    const maxBlockHeightFailures = 3;
    const wallClockDeadline = Date.now() + 2 * 60 * 1000;
    let blockHeightFailures = 0;
    let delay = Math.max(Math.floor(pollIntervalMs / 4), 250);

    while (Date.now() < wallClockDeadline) {
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.5), pollIntervalMs);

      // Check confirmation status
      try {
        const status = await this.rpc.getSignatureStatuses([signature]).send();
        const check = this.checkSignatureResult(signature, status.value[0]);

        if (check?.confirmed) {
          return { signature, slot: check.slot };
        }

        // Transaction seen (e.g. 'processed') — keep polling, don't rebroadcast
        if (check) continue;
      } catch (error) {
        if (error instanceof SvmTransactionError) throw error;
        this.logger.debug('Status poll failed', { error });
      }

      // Check if blockhash expired
      try {
        const currentBlockHeight = await this.rpc
          .getBlockHeight({ commitment: RPC_COMMITMENT_LEVEL })
          .send();

        // Reset on successful fetch
        blockHeightFailures = 0;
        if (currentBlockHeight > lastValidBlockHeight) {
          return null;
        }
      } catch (error) {
        blockHeightFailures++;
        this.logger.debug('Block height check failed', { error });
        if (blockHeightFailures >= maxBlockHeightFailures) {
          this.logger.warn(
            `Block height check failed ${maxBlockHeightFailures} times, treating as expired`,
          );
          return null;
        }
      }

      // Rebroadcast same signed tx (fire-and-forget, always skip preflight)
      try {
        await this.rpc
          .sendTransaction(rawTx, {
            encoding: 'base64',
            skipPreflight: true,
            maxRetries: 0n,
          })
          .send();
      } catch (error) {
        this.logger.debug('Rebroadcast failed', { error, signature });
      }
    }

    // Wall-clock timeout exceeded — tx fate unknown, unsafe to resubmit
    throw new Error(
      `Poll timeout exceeded for ${signature}, aborting to prevent potential double-execution`,
    );
  }

  async sendAndConfirmTransaction(
    transaction: SendableSvmExtraSignerTransaction,
  ): Promise<SvmReceipt> {
    return this.send(transaction);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: SendableSvmExtraSignerTransaction[],
  ): Promise<SvmReceipt> {
    throw new Error('Sealevel does not support transaction batching');
  }
}
