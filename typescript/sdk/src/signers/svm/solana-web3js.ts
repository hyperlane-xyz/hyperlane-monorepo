import {
  type Blockhash,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionConfirmationStatus,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  Address,
  ProtocolType,
  rootLogger,
  sleep,
  assert,
  bufferToBase58,
  TransactionSubmission,
} from '@hyperlane-xyz/utils';

import { SEALEVEL_PRIORITY_FEES } from '../../consts/sealevel.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { SendTransactionOptions } from '../../providers/MultiProvider.js';
import { SolanaWeb3Transaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

/**
 * Rewrite a `VersionedTransaction`'s blockhash and clear its signatures so
 * the caller can re-sign with the fresh blockhash. `MessageV0.recentBlockhash`
 * is declared `readonly` in TypeScript but is a plain mutable field at
 * runtime; the same pattern is used by `@solana/wallet-adapter` resubmit
 * examples. `Object.assign` performs the write without a type assertion.
 * Returns the same instance for chaining.
 */
function stampVersionedBlockhash(
  tx: VersionedTransaction,
  blockhash: Blockhash,
): VersionedTransaction {
  Object.assign(tx.message, { recentBlockhash: blockhash });
  for (let i = 0; i < tx.signatures.length; i++) {
    tx.signatures[i] = new Uint8Array(64);
  }
  return tx;
}

/**
 * Interface for SVM transaction signers. Accepts both legacy `Transaction`
 * and `VersionedTransaction` — the latter is required by Sealevel warp
 * transfer_remote calls compressed with Address Lookup Tables.
 */
export interface SvmTransactionSigner {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;
}

export interface SvmSignerConfig {
  /** Max polling attempts before timeout (default: 30) */
  maxConfirmationAttempts?: number;
  /** Delay between polling attempts in ms (default: 1000) */
  pollingDelayMs?: number;
  /** Commitment level for confirmation (default: 'confirmed') */
  commitment?: TransactionConfirmationStatus;
  /** @deprecated Fresh blockhash resubmission is unsafe after broadcast; true is rejected. */
  enableBlockhashResubmit?: boolean;
  /** Whether to retry on RPC errors during polling (default: true) */
  retryOnRpcErrors?: boolean;
}

export interface TransactionBuildOptions {
  /** Optional priority fee override (microLamports) */
  priorityFee?: number;
  /** Whether to include priority fee instruction (default: true) */
  includePriorityFee?: boolean;
}

/**
 * Keypair-based SVM transaction signer
 */
export class KeypairSvmTransactionSigner implements SvmTransactionSigner {
  public readonly publicKey: PublicKey;
  private readonly keypair: Keypair;

  constructor(privateKey: Uint8Array) {
    this.keypair = Keypair.fromSecretKey(privateKey);
    this.publicKey = this.keypair.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    // `VersionedTransaction.sign([signer])` populates only the signer's
    // slot (other signature slots stay as their pre-initialized zero bytes),
    // matching the partial-sign semantics of legacy `Transaction.partialSign`.
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([this.keypair]);
    } else {
      transaction.partialSign(this.keypair);
    }
    return transaction;
  }
}

export class SvmMultiProtocolSignerAdapter implements IMultiProtocolSigner<ProtocolType.Sealevel> {
  private readonly signer: SvmTransactionSigner;
  private readonly svmProvider: Connection;
  private readonly config: Required<SvmSignerConfig>;
  private readonly logger = rootLogger.child({
    module: 'SvmMultiProtocolSignerAdapter',
  });

  constructor(
    private readonly chainName: ChainName,
    signer: SvmTransactionSigner,
    multiProtocolProvider: MultiProviderAdapter,
    config?: SvmSignerConfig,
  ) {
    this.signer = signer;
    this.svmProvider = multiProtocolProvider.getSolanaWeb3Provider(chainName);
    this.config = {
      maxConfirmationAttempts: config?.maxConfirmationAttempts ?? 30,
      pollingDelayMs: config?.pollingDelayMs ?? 1000,
      commitment: config?.commitment ?? 'confirmed',
      enableBlockhashResubmit: config?.enableBlockhashResubmit ?? false,
      retryOnRpcErrors: config?.retryOnRpcErrors ?? true,
    };
  }

  publicKey(): PublicKey {
    return this.signer.publicKey;
  }

  async address(): Promise<Address> {
    return this.signer.publicKey.toBase58();
  }

  /**
   * Build and send a transaction from raw instructions
   */
  async buildAndSendTransaction(
    instructions: TransactionInstruction[],
    options?: TransactionBuildOptions,
  ): Promise<string> {
    const tx = this.buildTransaction(instructions, options);
    return this.signAndConfirm(tx);
  }

  /**
   * Send and confirm a pre-built transaction (IMultiProtocolSigner interface)
   */
  async sendAndConfirmTransaction(
    tx: SolanaWeb3Transaction,
    options?: SendTransactionOptions,
  ): Promise<string> {
    return this.signAndConfirm(tx.transaction, tx.extraSigners, options);
  }

  // ============ Private Methods ============

  /**
   * Build transaction from instructions with optional priority fees
   */
  private buildTransaction(
    instructions: TransactionInstruction[],
    options?: TransactionBuildOptions,
  ): Transaction {
    const tx = new Transaction();

    // Add priority fee if enabled and not already present
    const includePriorityFee = options?.includePriorityFee ?? true;
    if (includePriorityFee) {
      const hasPriorityFeeIx = instructions.some((ix) =>
        ix.programId.equals(ComputeBudgetProgram.programId),
      );
      if (!hasPriorityFeeIx) {
        const priorityFee =
          options?.priorityFee ?? SEALEVEL_PRIORITY_FEES[this.chainName];
        if (priorityFee) {
          tx.add(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: priorityFee,
            }),
          );
        }
      }
    }

    // Add all instructions
    instructions.forEach((ix) => tx.add(ix));
    tx.feePayer = this.signer.publicKey;

    return tx;
  }

  /**
   * Sign once and retain that identity through confirmation uncertainty
   */
  private async signAndConfirm(
    transaction: Transaction | VersionedTransaction,
    extraSigners?: Keypair[],
    options?: SendTransactionOptions,
  ): Promise<string> {
    const submission = new TransactionSubmission(options);
    const execute = async () => {
      assert(
        !(
          options?.enableBlockhashResubmit ??
          this.config.enableBlockhashResubmit
        ),
        'Automatic Solana blockhash resubmission is unsupported; use false to preserve one transaction identity',
      );
      // Get initial blockhash
      const { blockhash } = await this.svmProvider.getLatestBlockhash(
        this.config.commitment,
      );

      if (transaction instanceof VersionedTransaction) {
        stampVersionedBlockhash(transaction, blockhash);
        // `VersionedTransaction.sign([signer])` only populates the signer's
        // slot (matches partial-sign semantics of legacy `partialSign`).
        for (const signer of extraSigners ?? []) {
          transaction.sign([signer]);
        }
      } else {
        transaction.recentBlockhash = blockhash;
        if (!transaction.feePayer) {
          transaction.feePayer = this.signer.publicKey;
        }
        // Sign with extra signers first (e.g., randomWallet for Sealevel
        // transferRemote). Uses partialSign to avoid clearing any existing
        // signatures. This re-signs with the fresh blockhash, overwriting
        // the adapter's pre-sign.
        for (const signer of extraSigners ?? []) {
          transaction.partialSign(signer);
        }
      }

      // Sign with main signer (preserves extra signers' signatures)
      const signedTx = await this.signer.signTransaction(transaction);

      // Send initial transaction
      const rawSignature =
        signedTx instanceof VersionedTransaction
          ? signedTx.signatures[0]
          : signedTx.signature;
      assert(rawSignature, 'Signed Solana transaction has no payer signature');
      const signedSignature = bufferToBase58(Buffer.from(rawSignature));
      const signature = await submission.submit(
        () => this.sendRawTransaction(signedTx),
        (hash) => {
          assert(
            hash === signedSignature,
            'Solana RPC returned a different transaction signature',
          );
          return signedSignature;
        },
        signedSignature,
      );
      return this.pollForConfirmation(signature);
    };
    return submission.run(execute);
  }

  /**
   * Poll only the original signature. Absence or expiry cannot prove it never landed.
   */
  private async pollForConfirmation(signature: string): Promise<string> {
    let attempts = 0;

    while (attempts < this.config.maxConfirmationAttempts) {
      await sleep(this.config.pollingDelayMs);
      attempts++;

      try {
        // Check if transaction is confirmed
        const isConfirmed = await this.checkTransactionConfirmation(signature);
        if (isConfirmed) {
          this.logger.info(
            `Transaction ${signature} confirmed after ${attempts} attempts`,
          );
          return signature;
        }
      } catch (error) {
        // If it's a transaction failure error, rethrow immediately
        if (
          error instanceof Error &&
          error.message.includes('Transaction failed')
        ) {
          throw error;
        }

        // Handle RPC errors based on config
        if (!this.config.retryOnRpcErrors) {
          throw error;
        }

        // Log RPC errors but continue polling (temporary issues)
        this.logger.warn(`Polling attempt ${attempts} failed: ${error}`);
      }
    }

    throw new Error(
      `Transaction confirmation timeout after ${this.config.maxConfirmationAttempts} attempts`,
    );
  }

  /**
   * Check if transaction is confirmed
   * Returns true if confirmed, false if pending
   * Throws if transaction failed
   */
  private async checkTransactionConfirmation(
    signature: string,
  ): Promise<boolean> {
    const status = await this.svmProvider.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });

    if (!status.value) {
      return false; // Transaction not yet seen
    }

    // Check for transaction error
    if (status.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(status.value.err)}`,
      );
    }

    // Check if confirmed at required commitment level
    const confirmationStatus = status.value.confirmationStatus;
    return (
      confirmationStatus === this.config.commitment ||
      confirmationStatus === 'finalized'
    );
  }

  /**
   * Send signed transaction to network
   */
  private async sendRawTransaction(
    transaction: Transaction | VersionedTransaction,
  ): Promise<string> {
    return await this.svmProvider.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
}
