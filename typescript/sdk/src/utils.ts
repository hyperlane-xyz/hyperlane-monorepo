import { arrayify, BytesLike, hexlify } from '@ethersproject/bytes';
import { ethers } from 'ethers';
import { BigNumber, FixedNumber } from 'ethers';

export type Address = string;

/**
 * Converts a 20-byte (or other length) ID to a 32-byte ID.
 * Ensures that a bytes-like is 32 long. left-padding with 0s if not.
 *
 * @param data A string or array of bytes to canonize
 * @returns A Uint8Array of length 32
 */
export function canonizeId(data: BytesLike): Uint8Array {
  if (!data) throw new Error('Bad input. Undefined');
  const buf = ethers.utils.arrayify(data);
  if (buf.length > 32) {
    throw new Error('Too long');
  }
  if (buf.length !== 20 && buf.length != 32) {
    throw new Error('bad input, expect address or bytes32');
  }
  return ethers.utils.zeroPad(buf, 32);
}

/**
 * Converts an Abacus ID of 20 or 32 bytes to the corresponding EVM Address.
 *
 * For 32-byte IDs this enforces the EVM convention of using the LAST 20 bytes.
 *
 * @param data The data to truncate
 * @returns A 20-byte, 0x-prepended hex string representing the EVM Address
 * @throws if the data is not 20 or 32 bytes
 */
export function evmId(data: BytesLike): Address {
  const u8a = arrayify(data);

  if (u8a.length === 32) {
    return hexlify(u8a.slice(12, 32));
  } else if (u8a.length === 20) {
    return hexlify(u8a);
  } else {
    throw new Error(`Invalid id length. expected 20 or 32. Got ${u8a.length}`);
  }
}

/**
 * Sleep async for some time.
 *
 * @param ms the number of milliseconds to sleep
 * @returns A delay promise
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts a BigNumber to a FixedNumber of the format fixed128x18.
 * @param big The BigNumber to convert.
 * @returns A FixedNumber representation of a BigNumber.
 */
export function bigToFixed(big: BigNumber): FixedNumber {
  return FixedNumber.from(
    big.toString()
  );
}

/**
 * Converts a FixedNumber (of any format) to a BigNumber.
 * @param fixed The FixedNumber to convert.
 * @param ceil If true, the ceiling of fixed is used. Otherwise, the floor is used.
 * @returns A BigNumber representation of a FixedNumber.
 */
export function fixedToBig(fixed: FixedNumber, ceil: boolean = false): BigNumber {
  const fixedAsInteger = ceil ? fixed.ceiling() : fixed.floor();
  return BigNumber.from(
    fixedAsInteger.toFormat('fixed256x0').toString()
  )
}

/**
 * Multiplies a BigNumber by a FixedNumber, returning the BigNumber product.
 * @param big The BigNumber to multiply.
 * @param fixed The FixedNumber to multiply.
 * @param ceil If true, the ceiling of the product is used. Otherwise, the floor is used.
 * @returns The BigNumber product.
 */
export function mulBigAndFixed(big: BigNumber, fixed: FixedNumber, ceil: boolean = false): BigNumber {
  // Converts big to a FixedNumber, multiplies it by fixed, and converts the product back
  // to a BigNumber.
  return fixedToBig(
    fixed
      .mulUnsafe(
        bigToFixed(
          big,
        )
      ),
    ceil
  );
}