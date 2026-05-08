import { type ByteCursor, concatBytes, i64le, u32le } from './binary.js';
import { decodeBTreeSetH160, encodeBTreeSetH160 } from './fee.js';

/**
 * Off-chain quoting configuration on an IGP account.
 *
 * Mirrors the Rust `IgpFeeConfig` struct. `signers` is a `BTreeSet<H160>`
 * on-chain; the encoder (via `encodeBTreeSetH160`) handles sort + dedup.
 * Hex strings (0x-prefixed, lowercase) match how the fee program already
 * exposes signer sets.
 */
export interface IgpFeeConfig {
  signers: string[];
  domainId: number;
  minIssuedAt: bigint;
}

export function encodeIgpFeeConfig(value: IgpFeeConfig): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      encodeBTreeSetH160(value.signers),
      u32le(value.domainId),
      i64le(value.minIssuedAt),
    ),
  );
}

export function decodeIgpFeeConfig(cursor: ByteCursor): IgpFeeConfig {
  const signers = decodeBTreeSetH160(cursor);
  const domainId = cursor.readU32LE();
  const minIssuedAt = cursor.readI64LE();
  return { signers, domainId, minIssuedAt };
}

/**
 * Reads an optional trailing `IgpFeeConfig` from the cursor, mirroring the
 * Rust `read_optional_trailing` semantics:
 *
 *   - no remaining bytes → undefined (pre-upgrade account)
 *   - tag byte `0`        → undefined (explicit None)
 *   - tag byte `1`        → decoded `IgpFeeConfig`
 *   - any other byte      → throws
 */
export function readOptionalTrailingIgpFeeConfig(
  cursor: ByteCursor,
): IgpFeeConfig | undefined {
  if (cursor.remaining() === 0) return undefined;
  const tag = cursor.readU8();
  if (tag === 0) return undefined;
  if (tag !== 1) {
    throw new Error(`Invalid IgpFeeConfig option tag: ${tag}`);
  }
  return decodeIgpFeeConfig(cursor);
}
