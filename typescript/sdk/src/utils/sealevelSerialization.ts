import { assert } from '@hyperlane-xyz/utils';

/**
 * Length of the self-describing discriminator prefixed to a present
 * `OptionalDiscriminatedData<T>` trailing field. Mirrors
 * `Discriminator::LENGTH` in rust/sealevel/libraries/account-utils.
 */
export const SEALEVEL_DISCRIMINATOR_SIZE = 8;

/**
 * Read a self-describing optional trailing field, mirroring
 * `OptionalDiscriminatedData<T>::deserialize_reader` in
 * rust/sealevel/libraries/account-utils/src/discriminator.rs.
 *
 * A present value is serialized on-chain as `[T::DISCRIMINATOR][payload]` and
 * an absent one as zero bytes. On read the tail is the value's payload only if
 * it begins with exactly `discriminator`; an empty tail, a tail shorter than
 * the discriminator, or any non-matching tail (e.g. stale bytes in an
 * over-allocated account) all decode to `undefined` rather than erroring.
 *
 * Returns the payload bytes following the discriminator, or `undefined` when
 * absent. A matching discriminator with a truncated payload is the caller's
 * responsibility to detect.
 */
export function readOptionalDiscriminatedTrailing(
  rawAccountData: Buffer,
  offset: number,
  discriminator: Buffer,
): Buffer | undefined {
  assert(
    discriminator.length === SEALEVEL_DISCRIMINATOR_SIZE,
    `Discriminator must be ${SEALEVEL_DISCRIMINATOR_SIZE} bytes`,
  );
  const payloadOffset = offset + SEALEVEL_DISCRIMINATOR_SIZE;
  // Empty or too-short tail => the field is absent (None), not an error.
  if (rawAccountData.length < payloadOffset) return undefined;
  const tail = rawAccountData.subarray(offset, payloadOffset);
  // Stale / non-matching tail => absent, matching on-chain behaviour.
  if (!tail.equals(discriminator)) return undefined;
  return rawAccountData.subarray(payloadOffset);
}

export class SealevelInstructionWrapper<Instr> {
  instruction!: number;
  data!: Instr;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export class SealevelAccountDataWrapper<T> {
  initialized!: boolean;
  discriminator?: unknown;
  data!: T;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export function getSealevelAccountDataSchema<T>(
  DataClass: T,
  discriminator?: any,
) {
  return {
    kind: 'struct',
    fields: [
      ['initialized', 'u8'],
      ...(discriminator ? [['discriminator', discriminator]] : []),
      ['data', DataClass],
    ],
  };
}

// The format of simulation return data from the Sealevel programs.
// A trailing non-zero byte was added due to a bug in Sealevel RPCs that would
// truncate responses with trailing zero bytes.
export class SealevelSimulationReturnData<T> {
  return_data!: T;
  trailing_byte!: number;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export function getSealevelSimulationReturnDataSchema<T>(DataClass: T) {
  return {
    kind: 'struct',
    fields: [
      ['data', DataClass],
      ['trailing_byte', 'u8'],
    ],
  };
}
