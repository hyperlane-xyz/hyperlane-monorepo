import { createPublicKey, verify } from 'node:crypto';

import {
  address,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { eqAddressSol, fromHexString } from '@hyperlane-xyz/utils';

import type { SignerAccount, TransactionCodec } from './types.js';

const ED25519_SPKI_PREFIX = fromHexString('302a300506032b6570032100');
export const MAX_SVM_TRANSACTION_BYTES = 1232;
const transactionDecoder = getTransactionDecoder();
const transactionEncoder = getTransactionEncoder();
const messageDecoder = getCompiledTransactionMessageDecoder();
const base58Encoder = getBase58Encoder();

function decode(bytes: Uint8Array) {
  const transaction = transactionDecoder.decode(bytes);
  const canonicalBytes = transactionEncoder.encode(transaction);
  if (!Buffer.from(bytes).equals(Uint8Array.from(canonicalBytes))) {
    throw new Error('Expected a canonical Sealevel wire transaction');
  }
  return transaction;
}

function verifyEd25519(
  address: string,
  signature: Uint8Array,
  message: Uint8Array,
): boolean {
  const publicKeyBytes = base58Encoder.encode(address);
  if (publicKeyBytes.length !== 32)
    throw new Error('Invalid Sealevel signer address');
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Uint8Array.from(publicKeyBytes)]),
    format: 'der',
    type: 'spki',
  });
  return verify(
    null,
    Uint8Array.from(message),
    publicKey,
    Uint8Array.from(signature),
  );
}

function decodeMessage(messageBytes: Uint8Array) {
  const message = messageDecoder.decode(messageBytes);
  if (message.version === 1) {
    throw new Error('Sealevel v1 transactions are not supported');
  }
  return message;
}

export class SvmTransactionCodec implements TransactionCodec {
  validateUnsigned(
    bytes: Uint8Array,
    _metadata: ChainMetadata,
    account: SignerAccount,
  ): void {
    if (account.curve !== 'ed25519') {
      throw new Error('Sealevel signer must use ed25519');
    }
    const transaction = decode(bytes);
    decodeMessage(Uint8Array.from(transaction.messageBytes));
    if (!(address(account.address) in transaction.signatures)) {
      throw new Error(
        'Configured account is not a required transaction signer',
      );
    }
  }

  validateSigned(
    unsignedBytes: Uint8Array,
    signedBytes: Uint8Array,
    _metadata: ChainMetadata,
    account: SignerAccount,
  ): Record<string, string> {
    if (signedBytes.length > MAX_SVM_TRANSACTION_BYTES) {
      throw new Error(
        `Signed Sealevel transaction exceeds ${MAX_SVM_TRANSACTION_BYTES} byte limit`,
      );
    }
    const unsigned = decode(unsignedBytes);
    const signed = decode(signedBytes);
    if (
      !Buffer.from(Uint8Array.from(unsigned.messageBytes)).equals(
        Uint8Array.from(signed.messageBytes),
      )
    ) {
      throw new Error('Backend changed Sealevel message bytes while signing');
    }

    for (const [addressString, signature] of Object.entries(
      unsigned.signatures,
    )) {
      if (eqAddressSol(addressString, account.address)) continue;
      const returned = signed.signatures[address(addressString)];
      if (
        signature === null
          ? returned !== null
          : returned === null || !Buffer.from(signature).equals(returned)
      ) {
        throw new Error('Backend changed another Sealevel signature slot');
      }
    }

    const signature = signed.signatures[address(account.address)];
    if (
      signature === null ||
      !verifyEd25519(
        account.address,
        signature,
        Uint8Array.from(signed.messageBytes),
      )
    ) {
      throw new Error('Backend returned an invalid Sealevel signature');
    }

    const message = decodeMessage(Uint8Array.from(signed.messageBytes));
    const programIds = Array.from(
      new Set(
        message.instructions.map((instruction) => {
          const program =
            message.staticAccounts[instruction.programAddressIndex];
          if (!program)
            throw new Error('Invalid Sealevel program address index');
          return program;
        }),
      ),
    ).join(',');
    return { signer: account.address, programIds };
  }
}
