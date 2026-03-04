import {
  type KeyPairSigner,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
  addSignersToTransactionMessage,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import { createRpc } from '../rpc.js';
import { DEFAULT_COMPUTE_UNITS, buildTransactionMessage } from '../tx.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from '../types.js';

import { SvmProvider } from './provider.js';

const base58Encoder = getBase58Encoder();

function parseKeyBytes(privateKey: string): Uint8Array {
  // Try hex (32 bytes = 64 hex chars, 64 bytes = 128 hex chars)
  const stripped = strip0x(privateKey);
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  }
  if (/^[0-9a-fA-F]{128}$/.test(stripped)) {
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  }

  // Try base58
  let keyBytes: Uint8Array;
  try {
    keyBytes = new Uint8Array(base58Encoder.encode(privateKey));
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
  private readonly rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    signer: TransactionSigner,
    rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  ) {
    super(rpc, rpcUrls);
    this.signer = signer;
    this.rpcSubscriptions = rpcSubscriptions;
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    _extraParams?: Record<string, any>,
    rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
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

    return new SvmSigner(rpc, rpcUrls, keypair, rpcSubscriptions);
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: SvmTransaction,
  ): Promise<object> {
    return {
      instructions: transaction.instructions.map((ix) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data ? Buffer.from(ix.data).toString('hex') : undefined,
      })),
      computeUnits: transaction.computeUnits,
    };
  }

  async send(tx: SvmTransaction): Promise<SvmReceipt> {
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
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

    if (this.rpcSubscriptions) {
      const sendAndConfirm = sendAndConfirmTransactionFactory({
        rpc: this.rpc,
        rpcSubscriptions: this.rpcSubscriptions,
      });
      // buildTransactionMessage always uses blockhash lifetime.
      // signTransactionMessageWithSigners widens the type to the lifetime union,
      // so cast to the exact parameter type expected by sendAndConfirm.
      await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
        commitment: 'confirmed',
      });
      return { signature };
    }

    // Fallback: manual send + poll (no rpcSubscriptions provided).
    // Prefer passing rpcSubscriptions for reliable confirmation semantics.
    const base64Tx = getBase64EncodedWireTransaction(signedTx);
    await this.rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: false,
      })
      .send();

    let confirmed = false;
    let slot: bigint = 0n;
    const maxRetries = 120;
    for (let i = 0; i < maxRetries && !confirmed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await this.rpc.getSignatureStatuses([signature]).send();
      const result = status.value[0];
      if (result && result.confirmationStatus) {
        if (result.err) {
          throw new Error(
            `Transaction failed: ${signature}, err: ${JSON.stringify(result.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
          );
        }
        if (
          result.confirmationStatus === 'confirmed' ||
          result.confirmationStatus === 'finalized'
        ) {
          confirmed = true;
          slot = BigInt(result.slot);
        }
      }
    }

    if (!confirmed) {
      throw new Error(`Transaction not confirmed: ${signature}`);
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
