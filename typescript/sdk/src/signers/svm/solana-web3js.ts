import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  type PublicKey,
  Transaction,
  type TransactionConfirmationStatus,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  type Address,
  type ProtocolType,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import { SEALEVEL_PRIORITY_FEES } from '../../consts/sealevel.js';
import { type MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { type SolanaWeb3Transaction } from '../../providers/ProviderType.js';
import { type ChainName } from '../../types.js';
import { type IMultiProtocolSigner } from '../types.js';

/**
 * Interface for SVM transaction signers
 */
export interface SvmTransactionSigner {
  readonly publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export interface SvmSignerConfig {
  /** Max polling attempts before timeout (default: 30) */
  maxConfirmationAttempts?: number;
  /** Delay between polling attempts in ms (default: 1000) */
  pollingDelayMs?: number;
  /** Commitment level for confirmation (default: 'confirmed') */
  commitment?: TransactionConfirmationStatus;
  /** Whether to automatically resubmit on blockhash expiry (default: true) */
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

  async signTransaction(transaction: Transaction): Promise<Transaction> {
    transaction.sign(this.keypair);
    return transaction;
  }
}

export class SvmMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Sealevel>
{
  private readonly signer: SvmTransactionSigner;
  private readonly svmProvider: Connection;
  private readonly config: Required<SvmSignerConfig>;
  private readonly logger = rootLogger.child({
    module: 'SvmMultiProtocolSignerAdapter',
  });

  constructor(
    private readonly chainName: ChainName,
    signer: SvmTransactionSigner,
    multiProtocolProvider: MultiProtocolProvider,
    config?: SvmSignerConfig,
  ) {
    this.signer = signer;
    this.svmProvider = multiProtocolProvider.getSolanaWeb3Provider(chainName);
    this.config = {
      maxConfirmationAttempts: config?.maxConfirmationAttempts ?? 30,
      pollingDelayMs: config?.pollingDelayMs ?? 1000,
      commitment: config?.commitment ?? 'confirmed',
      enableBlockhashResubmit: config?.enableBlockhashResubmit ?? true,
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
  async sendAndConfirmTransaction(tx: SolanaWeb3Transaction): Promise<string> {
    return this.signAndConfirm(tx.transaction);
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
   * Sign and confirm transaction with blockhash resubmit on expiry
   */
  private async signAndConfirm(transaction: Transaction): Promise<string> {
    // Get initial blockhash
    const { blockhash, lastValidBlockHeight } =
      await this.svmProvider.getLatestBlockhash(this.config.commitment);

    transaction.recentBlockhash = blockhash;
    const signedTx = await this.signer.signTransaction(transaction);

    // Send initial transaction
    const signature = await this.sendRawTransaction(signedTx);

    // Poll for confirmation with optional resubmit
    const result = await this.pollForConfirmation(
      signature,
      signedTx,
      lastValidBlockHeight,
    );

    return result;
  }

  /**
   * Poll for transaction confirmation with blockhash expiry handling
   */
  private async pollForConfirmation(
    initialSignature: string,
    transaction: Transaction,
    lastValidBlockHeight: number,
  ): Promise<string> {
    let signature = initialSignature;
    let attempts = 0;
    let currentLastValidBlockHeight = lastValidBlockHeight;

    while (attempts < this.config.maxConfirmationAttempts) {
      await sleep(this.config.pollingDelayMs);
      attempts++;

      try {
        // Check and handle blockhash expiry
        const resubmitResult = await this.checkAndResubmitIfExpired(
          signature,
          transaction,
          currentLastValidBlockHeight,
        );
        if (resubmitResult) {
          signature = resubmitResult.signature;
          currentLastValidBlockHeight = resubmitResult.lastValidBlockHeight;
          continue;
        }

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
   * Check if blockhash expired and resubmit transaction if needed
   * Returns new signature and lastValidBlockHeight if resubmitted, null otherwise
   */
  private async checkAndResubmitIfExpired(
    signature: string,
    transaction: Transaction,
    lastValidBlockHeight: number,
  ): Promise<{ signature: string; lastValidBlockHeight: number } | null> {
    if (!this.config.enableBlockhashResubmit) {
      return null;
    }

    const currentBlockHeight = await this.svmProvider.getBlockHeight();
    if (currentBlockHeight <= lastValidBlockHeight) {
      return null; // Blockhash still valid
    }

    this.logger.warn(
      `Blockhash expired at block ${lastValidBlockHeight}, current ${currentBlockHeight}. Resubmitting...`,
    );

    // Get fresh blockhash and resubmit
    const { blockhash, lastValidBlockHeight: newLastValid } =
      await this.svmProvider.getLatestBlockhash(this.config.commitment);

    transaction.recentBlockhash = blockhash;
    const signedTx = await this.signer.signTransaction(transaction);

    const newSignature = await this.sendRawTransaction(signedTx);

    this.logger.info(`Resubmitted with signature: ${newSignature}`);

    return {
      signature: newSignature,
      lastValidBlockHeight: newLastValid,
    };
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
  private async sendRawTransaction(transaction: Transaction): Promise<string> {
    return await this.svmProvider.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
}
