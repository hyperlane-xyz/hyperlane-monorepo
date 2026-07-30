import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  type Address,
  address as parseAddress,
  getAddressCodec,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { concatBytes, u32le, u48be } from './codecs/binary.js';
import type { SvmSignedQuote } from './codecs/fee.js';

/**
 * Domain tag prepended to every quote message hash to scope the signature
 * to Hyperlane SVM quoting. Mirrors `DOMAIN_TAG` in the quote-verifier
 * Rust library.
 */
const QUOTE_DOMAIN_TAG = new TextEncoder().encode('HyperlaneSvmQuote');

const CLIENT_SALT_LEN = 32;
const SIGNATURE_LEN = 65;
const U32_MAX = 0xffffffff;

const addressEncoder = getAddressCodec();

function addressBytes(address: Address): Uint8Array {
  return Uint8Array.from(addressEncoder.encode(address));
}

/**
 * Computes the scoped salt that binds a quote to a specific payer:
 *
 *     scoped_salt = keccak256(payer || client_salt)
 *
 * Matches `SvmSignedQuote::compute_scoped_salt` in the Rust verifier.
 */
export function computeScopedSalt(
  payer: Address,
  clientSalt: Uint8Array,
): Uint8Array {
  return keccak_256(
    Uint8Array.from(concatBytes(addressBytes(payer), clientSalt)),
  );
}

/**
 * Builds the keccak256 message hash that the offchain quote signer must
 * sign. Mirrors `SvmSignedQuote::build_message_hash`:
 *
 *     message = keccak256(
 *       DOMAIN_TAG ||
 *       fee_account (32 bytes) ||
 *       u32LE(domain_id) ||
 *       keccak256(context) ||
 *       keccak256(data) ||
 *       issued_at (6 bytes) ||
 *       expiry (6 bytes) ||
 *       scoped_salt (32 bytes)
 *     )
 */
export function buildSvmQuoteMessageHash(args: {
  feeAccount: Address;
  domainId: number;
  context: Uint8Array;
  data: Uint8Array;
  issuedAt: Uint8Array;
  expiry: Uint8Array;
  scopedSalt: Uint8Array;
}): Uint8Array {
  return keccak_256(
    Uint8Array.from(
      concatBytes(
        QUOTE_DOMAIN_TAG,
        addressBytes(args.feeAccount),
        u32le(args.domainId),
        keccak_256(args.context),
        keccak_256(args.data),
        args.issuedAt,
        args.expiry,
        args.scopedSalt,
      ),
    ),
  );
}

export interface SignSvmQuoteArgs {
  /** secp256k1 private key, 32 bytes. */
  privateKey: Uint8Array;
  /** Pubkey of the fee account / IGP account the quote applies to (base58). */
  feeAccount: string;
  /** Hyperlane domain id of the chain this quote is for. */
  domainId: number;
  /** Payer that will submit the quote; binds the scoped salt (base58). */
  payer: string;
  context: Uint8Array;
  data: Uint8Array;
  /** Unix-seconds issued-at timestamp. Encoded as u48 BE in the message hash. */
  issuedAt: bigint;
  /**
   * Unix-seconds expiry timestamp. `expiry === issuedAt` ⇒ transient.
   * Encoded as u48 BE in the message hash.
   */
  expiry: bigint;
  /**
   * 32 bytes of client-provided salt used in scoped-salt derivation and PDA
   * collision-avoidance. When omitted, cryptographically random bytes are
   * generated via the secp256k1 RNG.
   */
  clientSalt?: Uint8Array;
}

/**
 * Signs an offchain quote with the given secp256k1 private key, producing
 * the `SvmSignedQuote` shape the fee program and IGP both accept.
 *
 * The private key is held in memory while signing — same security posture as
 * viem's `privateKeyToAccount`. Callers are responsible for sourcing key
 * material safely (env var, KMS, etc.).
 */
export function signSvmQuote(args: SignSvmQuoteArgs): SvmSignedQuote {
  assert(
    Number.isInteger(args.domainId) &&
      args.domainId >= 0 &&
      args.domainId <= U32_MAX,
    `domainId must be a u32 (integer in [0, ${U32_MAX}]), got ${args.domainId}`,
  );

  const clientSalt = args.clientSalt ?? secp256k1.utils.randomSecretKey();
  assert(
    clientSalt.length === CLIENT_SALT_LEN,
    `clientSalt must be ${CLIENT_SALT_LEN} bytes, got ${clientSalt.length}`,
  );

  const issuedAt = u48be(args.issuedAt);
  const expiry = u48be(args.expiry);

  const scopedSalt = computeScopedSalt(parseAddress(args.payer), clientSalt);
  const messageHash = buildSvmQuoteMessageHash({
    feeAccount: parseAddress(args.feeAccount),
    domainId: args.domainId,
    context: args.context,
    data: args.data,
    issuedAt,
    expiry,
    scopedSalt,
  });

  const sig = secp256k1.sign(messageHash, args.privateKey, { prehash: false });
  const signature = new Uint8Array(SIGNATURE_LEN);
  signature.set(sig.toBytes('compact'), 0);
  signature[SIGNATURE_LEN - 1] = sig.recovery;

  return {
    context: args.context,
    data: args.data,
    issuedAt,
    expiry,
    clientSalt,
    signature,
  };
}

/**
 * Derives the Ethereum-style 20-byte H160 address that recovery against a
 * signature signed by `privateKey` will yield. Matches the on-chain
 * `secp256k1_recover_ethereum_address` derivation.
 */
export function ethAddressFromPrivateKey(privateKey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  // Drop the leading 0x04 tag, keccak the 64-byte (x || y), take last 20 bytes.
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('expected 65-byte uncompressed secp256k1 public key');
  }
  return keccak_256(uncompressed.slice(1)).slice(12);
}

/** Hex-prefixed lowercase Ethereum address (0x + 40 chars) for a private key. */
export function ethAddressHexFromPrivateKey(privateKey: Uint8Array): string {
  const bytes = ethAddressFromPrivateKey(privateKey);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
