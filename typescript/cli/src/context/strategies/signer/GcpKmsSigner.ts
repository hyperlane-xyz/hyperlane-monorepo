import { KeyManagementServiceClient } from '@google-cloud/kms';
import { ethers } from 'ethers';

// Parses DER SEQUENCE { INTEGER r, INTEGER s } from a GCP KMS secp256k1 signature.
function parseDerSignature(der: Uint8Array): { r: Buffer; s: Buffer } {
  let offset = 2; // skip SEQUENCE tag + length
  // r
  offset++; // INTEGER tag
  const rLen = der[offset++];
  let r = Buffer.from(der.slice(offset, offset + rLen));
  offset += rLen;
  // s
  offset++; // INTEGER tag
  const sLen = der[offset++];
  let s = Buffer.from(der.slice(offset, offset + sLen));

  // DER integers may have a leading 0x00 to indicate positive; strip it
  if (r[0] === 0x00) r = r.slice(1);
  if (s[0] === 0x00) s = s.slice(1);

  return { r, s };
}

// Extracts the uncompressed secp256k1 public key (65 bytes) from a PEM-encoded
// SubjectPublicKeyInfo. The BIT STRING payload ends with the 65-byte EC point.
function extractUncompressedPublicKey(pem: string): Buffer {
  const b64 = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  const der = Buffer.from(b64, 'base64');
  // Find the 0x04 uncompressed-point marker and take the 65 bytes from there
  const idx = der.lastIndexOf(0x04);
  return der.slice(idx, idx + 65);
}

export class GcpKmsSigner extends ethers.Signer {
  private readonly client: KeyManagementServiceClient;
  private cachedAddress?: string;

  constructor(
    private readonly keyId: string,
    provider?: ethers.providers.Provider,
  ) {
    super();
    this.client = new KeyManagementServiceClient();
    if (provider) {
      ethers.utils.defineReadOnly(this, 'provider', provider);
    }
  }

  connect(provider: ethers.providers.Provider): GcpKmsSigner {
    return new GcpKmsSigner(this.keyId, provider);
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;

    const [pubKey] = await this.client.getPublicKey({ name: this.keyId });
    const uncompressed = extractUncompressedPublicKey(pubKey.pem!);
    this.cachedAddress = ethers.utils.computeAddress(uncompressed);
    return this.cachedAddress;
  }

  async signMessage(message: ethers.utils.Bytes | string): Promise<string> {
    const hash = Buffer.from(
      ethers.utils.arrayify(ethers.utils.hashMessage(message)),
    );
    return this._signDigest(hash);
  }

  async signTransaction(
    transaction: ethers.providers.TransactionRequest,
  ): Promise<string> {
    const tx = await ethers.utils.resolveProperties(transaction);
    const serialized = ethers.utils.serializeTransaction(
      tx as ethers.UnsignedTransaction,
    );
    const hash = Buffer.from(
      ethers.utils.arrayify(ethers.utils.keccak256(serialized)),
    );
    const sig = await this._signDigest(hash);
    return ethers.utils.serializeTransaction(
      tx as ethers.UnsignedTransaction,
      sig,
    );
  }

  private async _signDigest(digest: Buffer): Promise<string> {
    const [response] = await this.client.asymmetricSign({
      name: this.keyId,
      digest: { sha256: digest },
    });

    const der = Buffer.isBuffer(response.signature)
      ? response.signature
      : Buffer.from(response.signature as Uint8Array);

    const { r, s } = parseDerSignature(der);
    const address = await this.getAddress();

    // Try both recovery values to find which produces the right address
    for (const v of [27, 28]) {
      const sig = ethers.utils.joinSignature({
        r: ethers.utils.hexlify(r),
        s: ethers.utils.hexlify(s),
        v,
      });
      const recovered = ethers.utils.recoverAddress(digest, sig);
      if (recovered.toLowerCase() === address.toLowerCase()) {
        return sig;
      }
    }

    throw new Error(
      'GcpKmsSigner: unable to determine recovery value for signature',
    );
  }
}
