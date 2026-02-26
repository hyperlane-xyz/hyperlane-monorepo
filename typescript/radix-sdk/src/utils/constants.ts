/**
 * Radix public key to be used for read/simulation in contexts where a
 * signer is not available.
 *
 * Generated using:
 * ```typescript
 *
 * const pk = new PrivateKey.Ed25519(new Uint8Array(randomBytes(32)));
 * const pubKey = pk.publicKeyHex()
 * ```
 */
export const READ_ACCOUNT_HEX_PUBLIC_KEY =
  '4e87d816766ad391ed7e91e09395b5ff1d899be0b94df63f6f2301acf7966dbc';

/**
 * Number of epochs a transaction remains valid after construction.
 * Each Radix epoch is ~5 minutes, so 10 epochs gives ~50 min validity.
 * A larger window prevents TransactionEpochNoLongerValid errors when
 * there is latency between transaction construction and submission.
 */
export const EPOCH_VALIDITY_RANGE = 10;
