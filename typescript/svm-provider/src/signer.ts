import {
  type Address,
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

import { strip0x } from '@hyperlane-xyz/utils';

import { DEFAULT_COMPUTE_UNITS, buildTransactionMessage } from './tx.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from './types.js';

export interface SvmSigner {
  signer: TransactionSigner;
  send(transaction: SvmTransaction): Promise<SvmReceipt>;
}

const base58Encoder = getBase58Encoder();

/**
 * Creates an SvmSigner from a private key and RPC client.
 *
 * @param privateKey - Hex (32/64 bytes), base58, or base64 private key
 * @param rpc - Solana RPC client for sending transactions
 * @param rpcSubscriptions - Optional subscriptions client; enables Kit-recommended
 *   sendAndConfirmTransaction confirmation. When omitted, falls back to polling.
 * @returns SvmSigner with `address`, `signer`, and `send(tx)`
 */
export async function createSigner(
  privateKey: string,
  rpc: SvmRpc,
  rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
): Promise<SvmSigner & { address: Address }> {
  let keyBytes: Uint8Array;

  const stripped = strip0x(privateKey);
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else if (/^[0-9a-fA-F]{128}$/.test(stripped)) {
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else {
    try {
      keyBytes = new Uint8Array(base58Encoder.encode(privateKey));
    } catch {
      keyBytes = new Uint8Array(Buffer.from(privateKey, 'base64'));
    }
  }

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

  const sendFn = async (tx: SvmTransaction): Promise<SvmReceipt> => {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    let txMessage = buildTransactionMessage({
      instructions: tx.instructions,
      feePayer: keypair,
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

    if (rpcSubscriptions) {
      const sendAndConfirm = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions,
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
    await rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: tx.skipPreflight ?? false,
      })
      .send();

    let confirmed = false;
    let slot: bigint = 0n;
    const maxRetries = 120;
    for (let i = 0; i < maxRetries && !confirmed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await rpc.getSignatureStatuses([signature]).send();
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

    const receipt = await rpc
      .getTransaction(signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();

    if (receipt && receipt.meta?.err) {
      throw new Error(`Transaction with signature ${signature} failed`, {
        cause: receipt.meta?.err,
      });
    }

    return { signature, slot };
  };

  return {
    address: keypair.address,
    signer: keypair,
    send: sendFn,
  };
}
