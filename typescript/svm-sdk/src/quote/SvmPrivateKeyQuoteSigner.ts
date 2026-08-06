import { secp256k1 } from '@noble/curves/secp256k1';
import { address as parseAddress } from '@solana/kit';

import {
  type QuoteSignature,
  type RawQuoteSigner,
  type SignableInput,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { u48be } from '../codecs/binary.js';
import {
  buildSvmQuoteMessageHash,
  ethAddressHexFromPrivateKey,
} from '../quote-signing.js';

import { parseSvmQuoteSignable } from './SvmQuoteSignable.js';

const PRIVATE_KEY_LEN = 32;
const SIGNATURE_LEN = 65;

/**
 * Default `RawQuoteSigner` implementation for SVM. Wraps a 32-byte secp256k1
 * private key and narrows the opaque cross-VM `SignableInput` envelope to an
 * `SvmQuoteSignable` via `parseSvmQuoteSignable`. Builds the keccak256-tagged
 * digest the `quote-verifier` Rust library expects and signs it.
 *
 * Throws when the input is not an `SvmQuoteSignable` — the EVM EIP-712 signer
 * is a parallel implementation, not a fallback path here.
 */
export class SvmPrivateKeyQuoteSigner implements RawQuoteSigner {
  constructor(private readonly privateKey: Uint8Array) {
    assert(
      privateKey.length === PRIVATE_KEY_LEN,
      `secp256k1 private key must be ${PRIVATE_KEY_LEN} bytes, got ${privateKey.length}.`,
    );
  }

  async address(): Promise<string> {
    return ethAddressHexFromPrivateKey(this.privateKey);
  }

  async sign(input: SignableInput): Promise<QuoteSignature> {
    const s = parseSvmQuoteSignable(input);
    const digest = buildSvmQuoteMessageHash({
      feeAccount: parseAddress(s.feeAccount),
      domainId: s.domainId,
      context: s.context,
      data: s.data,
      issuedAt: u48be(BigInt(s.issuedAt)),
      expiry: u48be(BigInt(s.expiry)),
      scopedSalt: s.scopedSalt,
    });

    const sig = secp256k1.sign(digest, this.privateKey, { prehash: false });
    const signature = new Uint8Array(SIGNATURE_LEN);
    signature.set(sig.toBytes('compact'), 0);
    signature[SIGNATURE_LEN - 1] = sig.recovery;
    return { signature };
  }
}
