import { BytesLike, utils } from 'ethers';

/**
 * Converts a 20-byte (or other length) ID to a 32-byte ID.
 * Ensures that a bytes-like is 32 long. left-padding with 0s if not.
 *
 * @param data A string or array of bytes to canonize
 * @returns A Uint8Array of length 32
 */
export function canonizeId(data: BytesLike): Uint8Array {
  if (!data) throw new Error('Bad input. Undefined');
  const buf = utils.arrayify(data);
  if (buf.length > 32) {
    throw new Error('Too long');
  }
  if (buf.length !== 20 && buf.length != 32) {
    throw new Error('bad input, expect address or bytes32');
  }
  return utils.zeroPad(buf, 32);
}

/**
 * Converts a Hyperlane ID of 20 or 32 bytes to the corresponding EVM Address.
 *
 * For 32-byte IDs this enforces the EVM convention of using the LAST 20 bytes.
 *
 * @param data The data to truncate
 * @returns A 20-byte, 0x-prepended hex string representing the EVM Address
 * @throws if the data is not 20 or 32 bytes
 */
export function evmId(data: BytesLike): string {
  const u8a = utils.arrayify(data);

  if (u8a.length === 32) {
    return utils.hexlify(u8a.slice(12, 32));
  } else if (u8a.length === 20) {
    return utils.hexlify(u8a);
  } else {
    throw new Error(`Invalid id length. expected 20 or 32. Got ${u8a.length}`);
  }
}
