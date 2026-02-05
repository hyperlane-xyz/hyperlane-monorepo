import {
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  createKeyPairSignerFromBytes,
  getSignatureFromTransaction,
  signTransaction,
} from '@solana/kit';

import { strip0x } from '@hyperlane-xyz/utils';

import { DEFAULT_COMPUTE_UNITS, buildTransaction } from './tx.js';
import type { SvmReceipt, SvmTransaction } from './types.js';

/**
 * Minimal SVM signer for signing and submitting transactions.
 * Not implementing ISigner interface - follows function-based pattern like cosmos-sdk.
 */
export interface SvmSigner {
  /** Public address of the signer */
  address: Address;

  /** KeyPair signer for signing transactions */
  keypair: KeyPairSigner;

  /**
   * Sign and send a single transaction.
   */
  signAndSend(rpc: Rpc<SolanaRpcApi>, tx: SvmTransaction): Promise<SvmReceipt>;

  /**
   * Sign and send multiple transactions sequentially.
   */
  signAndSendBatch(
    rpc: Rpc<SolanaRpcApi>,
    txs: SvmTransaction[],
  ): Promise<SvmReceipt[]>;
}

/**
 * Decode base58 string to bytes.
 */
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

  // Handle leading zeros
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

/**
 * Creates an SvmSigner from a private key.
 *
 * @param privateKey - Private key as hex string (with or without 0x prefix) or base58 string
 */
export async function createSigner(privateKey: string): Promise<SvmSigner> {
  let keyBytes: Uint8Array;

  // Detect if it's hex (0x prefix or 64 hex chars)
  const stripped = strip0x(privateKey);
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    // 32-byte hex private key
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else if (/^[0-9a-fA-F]{128}$/.test(stripped)) {
    // 64-byte hex keypair (full Ed25519 keypair)
    keyBytes = new Uint8Array(Buffer.from(stripped, 'hex'));
  } else {
    // Try base58 (Solana's native format)
    try {
      keyBytes = decodeBase58(privateKey);
    } catch {
      // Try base64 as fallback
      keyBytes = new Uint8Array(Buffer.from(privateKey, 'base64'));
    }
  }

  // Create keypair signer from bytes
  const keypair = await createKeyPairSignerFromBytes(keyBytes);

  const signAndSendFn = async (
    rpc: Rpc<SolanaRpcApi>,
    tx: SvmTransaction,
  ): Promise<SvmReceipt> => {
    // Get recent blockhash
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    // Build transaction
    const compiledTx = buildTransaction({
      instructions: tx.instructions,
      feePayer: keypair,
      recentBlockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      computeUnits: tx.computeUnits ?? DEFAULT_COMPUTE_UNITS,
    });

    // Sign transaction
    const signedTx = await signTransaction([keypair.keyPair], compiledTx);

    // Get signature
    const signature = getSignatureFromTransaction(signedTx);

    // Convert the full signed transaction to bytes for wire format
    // This is a simplified approach - @solana/kit handles this differently
    // We need to manually construct the wire format
    const msgBytes = signedTx.messageBytes;
    const sigMap = signedTx.signatures;

    // Build wire format: [signatures_count, ...signatures, message_bytes]
    const sigCount = Object.keys(sigMap).length;
    const sigsArray: Uint8Array[] = [];
    for (const sig of Object.values(sigMap)) {
      sigsArray.push(sig as Uint8Array);
    }

    // Calculate total length
    const totalLen = 1 + sigCount * 64 + msgBytes.length;
    const wireBytes = new Uint8Array(totalLen);

    // Write signatures count (compact-u16, but for small counts it's just 1 byte)
    wireBytes[0] = sigCount;

    // Write signatures
    let offset = 1;
    for (const sig of sigsArray) {
      wireBytes.set(sig, offset);
      offset += 64;
    }

    // Write message bytes
    wireBytes.set(msgBytes, offset);

    // Base64 encode
    const base64Tx = Buffer.from(wireBytes).toString('base64');

    // Send the transaction
    await rpc.sendTransaction(base64Tx as any, { encoding: 'base64' }).send();

    // Poll for confirmation
    let confirmed = false;
    let slot: bigint = 0n;
    const maxRetries = 60;
    for (let i = 0; i < maxRetries && !confirmed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await rpc.getSignatureStatuses([signature]).send();
      const result = status.value[0];
      if (result && result.confirmationStatus) {
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
    keypair,
    signAndSend: signAndSendFn,
    async signAndSendBatch(
      rpc: Rpc<SolanaRpcApi>,
      txs: SvmTransaction[],
    ): Promise<SvmReceipt[]> {
      const receipts: SvmReceipt[] = [];
      for (const tx of txs) {
        const receipt = await signAndSendFn(rpc, tx);
        receipts.push(receipt);
      }
      return receipts;
    },
  };
}
