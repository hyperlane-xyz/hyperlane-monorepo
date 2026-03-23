import {
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
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, rootLogger, strip0x } from '@hyperlane-xyz/utils';

import { createRpc } from '../rpc.js';
import {
  buildTransactionMessage,
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
    transaction: AnnotatedSvmTransaction,
  ): Promise<object> {
    const { transactionBase58, messageBase58 } = serializeUnsignedTransaction(
      transaction.instructions,
      this.signer.address,
    );

    return {
      annotation: transaction.annotation,
      instructions: transaction.instructions.map((ix) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data ? Buffer.from(ix.data).toString('hex') : undefined,
      })),
      computeUnits: transaction.computeUnits,
      transactionBase58,
      messageBase58,
    };
  }

  /**
   * Builds, signs, and sends a transaction with a confirmed blockhash.
   * Retries on blockhash-not-found errors from the RPC.
   * Returns the raw transaction bytes for rebroadcasting and the
   * lastValidBlockHeight for block-height-based expiry detection.
   */
  private async signAndSend(
    tx: SvmTransaction,
    maxAttempts = 3,
  ): Promise<{
    signature: Signature;
    rawTx: Base64EncodedWireTransaction;
    lastValidBlockHeight: bigint;
  }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { value: latestBlockhash } = await this.rpc
        .getLatestBlockhash({ commitment: 'confirmed' })
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
          })
          .send();

        return {
          signature,
          rawTx,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Blockhash not found') && attempt < maxAttempts - 1) {
          this.logger.warn(
            `Blockhash not found on send attempt ${attempt + 1}, retrying with fresh blockhash`,
          );
          continue;
        }
        throw error;
      }
    }
    throw new Error('signAndSend: all attempts exhausted');
  }

  /**
   * Evaluates a signature status result. Throws on error, returns
   * `{ confirmed: true, slot }` if confirmed/finalized, `{ confirmed: false }`
   * if still progressing, or `null` if the signature was not found.
   */
  private checkSignatureResult(
    signature: Signature,
    result: SignatureStatusResponse,
  ): { confirmed: true; slot: bigint } | { confirmed: false } | null {
    if (!result) return null;

    if (result.err) {
      throw new SvmTransactionError(signature, result.err);
    }

    if (
      result.confirmationStatus === 'confirmed' ||
      result.confirmationStatus === 'finalized'
    ) {
      return { confirmed: true, slot: result.slot };
    }

    return { confirmed: false };
  }

  async send(tx: SvmTransaction): Promise<SvmReceipt> {
    let { signature, rawTx, lastValidBlockHeight } = await this.signAndSend(tx);

    let confirmed = false;
    let slot: bigint = 0n;
    const maxPolls = 60;
    let delay = 500;
    for (let i = 0; i < maxPolls && !confirmed; i++) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 4000);
      try {
        // Check signature status
        const status = await this.rpc.getSignatureStatuses([signature]).send();
        const check = this.checkSignatureResult(signature, status.value[0]);

        if (check?.confirmed) {
          confirmed = true;
          slot = check.slot;
          break;
        }

        if (check) {
          // Transaction seen (e.g. 'processed') — keep polling, do NOT resubmit
          continue;
        }

        // Transaction not found — check if blockhash expired via block height
        const currentBlockHeight = await this.rpc
          .getBlockHeight({ commitment: 'confirmed' })
          .send();

        if (currentBlockHeight <= lastValidBlockHeight) {
          // Blockhash still valid — rebroadcast same signed transaction
          this.logger.debug('Rebroadcasting transaction');
          await this.rpc
            .sendTransaction(rawTx, {
              encoding: 'base64',
              skipPreflight: tx.skipPreflight ?? false,
            })
            .send();
          continue;
        }

        // Blockhash expired — deep check with transaction history search
        const historyStatus = await this.rpc
          .getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
          .send();
        const historyCheck = this.checkSignatureResult(
          signature,
          historyStatus.value[0],
        );

        if (historyCheck?.confirmed) {
          confirmed = true;
          slot = historyCheck.slot;
          break;
        }

        if (historyCheck) {
          // Found in history but still progressing — keep polling
          continue;
        }

        // Blockhash expired and signature never seen — safe to resubmit
        this.logger.warn(
          'Blockhash expired and transaction not found, resubmitting',
        );
        ({ signature, rawTx, lastValidBlockHeight } =
          await this.signAndSend(tx));
        delay = 500;
      } catch (error) {
        if (error instanceof SvmTransactionError) {
          throw error;
        }
        this.logger.warn(`Polling attempt ${i + 1} failed`, { error });
      }
    }

    if (!confirmed) {
      throw new Error(
        `Transaction not confirmed within polling timeout: ${signature}`,
      );
    }

    return { signature, slot };
  }

  async sendAndConfirmTransaction(
    transaction: SvmTransaction,
  ): Promise<SvmReceipt> {
    return this.send(transaction);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: SvmTransaction[],
  ): Promise<SvmReceipt> {
    throw new Error('Sealevel does not support transaction batching');
  }

  // ### TX CORE ###

  async createMailbox(
    _req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    throw new Error('createMailbox not supported on Sealevel');
  }

  async setDefaultIsm(
    _req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    throw new Error('setDefaultIsm not supported on Sealevel');
  }

  async setDefaultHook(
    _req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    throw new Error('setDefaultHook not supported on Sealevel');
  }

  async setRequiredHook(
    _req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    throw new Error('setRequiredHook not supported on Sealevel');
  }

  async setMailboxOwner(
    _req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    throw new Error('setMailboxOwner not supported on Sealevel');
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    throw new Error('createMerkleRootMultisigIsm not supported on Sealevel');
  }

  async createMessageIdMultisigIsm(
    _req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    throw new Error('createMessageIdMultisigIsm not supported on Sealevel');
  }

  async createRoutingIsm(
    _req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    throw new Error('createRoutingIsm not supported on Sealevel');
  }

  async setRoutingIsmRoute(
    _req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    throw new Error('setRoutingIsmRoute not supported on Sealevel');
  }

  async removeRoutingIsmRoute(
    _req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    throw new Error('removeRoutingIsmRoute not supported on Sealevel');
  }

  async setRoutingIsmOwner(
    _req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    throw new Error('setRoutingIsmOwner not supported on Sealevel');
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    throw new Error('createNoopIsm not supported on Sealevel');
  }

  async createMerkleTreeHook(
    _req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    throw new Error('createMerkleTreeHook not supported on Sealevel');
  }

  async createInterchainGasPaymasterHook(
    _req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    throw new Error(
      'createInterchainGasPaymasterHook not supported on Sealevel',
    );
  }

  async setInterchainGasPaymasterHookOwner(
    _req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    throw new Error(
      'setInterchainGasPaymasterHookOwner not supported on Sealevel',
    );
  }

  async setDestinationGasConfig(
    _req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    throw new Error('setDestinationGasConfig not supported on Sealevel');
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    throw new Error('removeDestinationGasConfig not supported on Sealevel');
  }

  async createNoopHook(
    _req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    throw new Error('createNoopHook not supported on Sealevel');
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    throw new Error('createValidatorAnnounce not supported on Sealevel');
  }

  async createProxyAdmin(
    _req: Omit<AltVM.ReqCreateProxyAdmin, 'signer'>,
  ): Promise<AltVM.ResCreateProxyAdmin> {
    throw new Error('createProxyAdmin not supported on Sealevel');
  }

  async setProxyAdminOwner(
    _req: Omit<AltVM.ReqSetProxyAdminOwner, 'signer'>,
  ): Promise<AltVM.ResSetProxyAdminOwner> {
    throw new Error('setProxyAdminOwner not supported on Sealevel');
  }

  // ### TX WARP ###

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    throw new Error(
      'createNativeToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async createCollateralToken(
    _req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    throw new Error(
      'createCollateralToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async createSyntheticToken(
    _req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    throw new Error(
      'createSyntheticToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenOwner(
    _req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    throw new Error(
      'setTokenOwner not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenIsm(
    _req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    throw new Error(
      'setTokenIsm not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenHook(
    _req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    throw new Error(
      'setTokenHook not supported on Sealevel, use the Artifact API instead',
    );
  }

  async enrollRemoteRouter(
    _req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    throw new Error(
      'enrollRemoteRouter not supported on Sealevel, use the Artifact API instead',
    );
  }

  async unenrollRemoteRouter(
    _req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    throw new Error(
      'unenrollRemoteRouter not supported on Sealevel, use the Artifact API instead',
    );
  }

  async transfer(
    _req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    throw new Error(
      'transfer not supported on Sealevel, use the Artifact API instead',
    );
  }

  async remoteTransfer(
    _req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    throw new Error(
      'remoteTransfer not supported on Sealevel, use the Artifact API instead',
    );
  }
}
