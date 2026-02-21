import {
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { strip0x } from '@hyperlane-xyz/utils';

import { DEFAULT_COMPUTE_UNITS, buildTransactionMessage } from './tx.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from './types.js';

export interface SvmSigner {
  signer: TransactionSigner;
  send(transaction: SvmTransaction): Promise<SvmReceipt>;
}

// FIXME do we need our own string->base58?
// there is a getBase58Codec() in @solana/codec-strings
function decodeBase58(input: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58;

  const bytes: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const value = ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

/**
 * Creates an SvmSigner from a private key and RPC client.
 *
 * @param privateKey - Hex (32/64 bytes), base58, or base64 private key
 * @param rpc - Solana RPC client for sending transactions
 * @returns SvmSigner with `address`, `signer`, and `send(tx)`
 */
export async function createSigner(
  privateKey: string,
  rpc: SvmRpc,
): Promise<SvmSigner & { address: Address }> {
  let keyBytes: Uint8Array;

  const stripped = strip0x(privateKey);
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else if (/^[0-9a-fA-F]{128}$/.test(stripped)) {
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else {
    try {
      keyBytes = decodeBase58(privateKey);
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

    const txMessage = buildTransactionMessage({
      instructions: tx.instructions,
      feePayer: keypair,
      recentBlockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      computeUnits: tx.computeUnits ?? DEFAULT_COMPUTE_UNITS,
    });

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const signature = getSignatureFromTransaction(signedTx);
    const base64Tx = getBase64EncodedWireTransaction(signedTx);

    await rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: true,
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

    return { signature, slot };
  };

  return {
    address: keypair.address,
    signer: keypair,
    send: sendFn,
  };
}
