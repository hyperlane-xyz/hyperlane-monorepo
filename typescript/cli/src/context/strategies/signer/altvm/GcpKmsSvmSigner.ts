import { KeyManagementServiceClient } from '@google-cloud/kms';
import {
  type Address,
  type MessagePartialSigner,
  type ReadonlyUint8Array,
  type SignableMessage,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
  type TransactionPartialSignerConfig,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  assertIsSignatureBytes,
  getBase58Decoder,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

type SignatureDictionary = Readonly<Record<Address, SignatureBytes>>;

// Extracts the 32-byte raw Ed25519 public key from a PEM-encoded
// SubjectPublicKeyInfo (DER). The key occupies the last 32 bytes of the structure.
function extractEd25519PublicKey(pem: string): Uint8Array {
  const b64 = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  const der = Buffer.from(b64, 'base64');
  return new Uint8Array(der.slice(-32));
}

/**
 * A Solana transaction/message signer backed by GCP KMS (Ed25519 key).
 * Implements MessagePartialSigner & TransactionPartialSigner so it is a
 * valid TransactionSigner accepted by @solana/kit utilities.
 */
export class GcpKmsSvmSigner
  implements MessagePartialSigner, TransactionPartialSigner
{
  private readonly client: KeyManagementServiceClient;
  readonly address: Address;

  private constructor(
    private readonly keyId: string,
    address: Address,
  ) {
    this.client = new KeyManagementServiceClient();
    this.address = address;
  }

  static async create(keyId: string): Promise<GcpKmsSvmSigner> {
    const client = new KeyManagementServiceClient();
    const [pubKey] = await client.getPublicKey({ name: keyId });
    assert(pubKey.pem, 'GCP KMS returned no public key PEM');

    const rawPubKey = extractEd25519PublicKey(pubKey.pem);
    const address = getBase58Decoder().decode(rawPubKey) as Address;

    return new GcpKmsSvmSigner(keyId, address);
  }

  async signMessages(
    messages: readonly SignableMessage[],
  ): Promise<readonly SignatureDictionary[]> {
    return Promise.all(
      messages.map(async (msg) => {
        const sig = await this._sign(msg.content);
        return { [this.address]: sig } as SignatureDictionary;
      }),
    );
  }

  async signTransactions(
    transactions: readonly (Transaction &
      TransactionWithinSizeLimit &
      TransactionWithLifetime)[],
    _config?: TransactionPartialSignerConfig,
  ): Promise<readonly SignatureDictionary[]> {
    return Promise.all(
      transactions.map(async (tx) => {
        const sig = await this._sign(tx.messageBytes);
        return { [this.address]: sig } as SignatureDictionary;
      }),
    );
  }

  private async _sign(data: ReadonlyUint8Array): Promise<SignatureBytes> {
    const [response] = await this.client.asymmetricSign({
      name: this.keyId,
      data: Buffer.from(data),
    });

    const sigBytes = Buffer.isBuffer(response.signature)
      ? response.signature
      : Buffer.from(response.signature as Uint8Array);

    assert(
      sigBytes.length === 64,
      `Expected 64-byte Ed25519 signature, got ${sigBytes.length}`,
    );
    const sig = new Uint8Array(sigBytes) as SignatureBytes;
    assertIsSignatureBytes(sig);
    return sig;
  }
}
