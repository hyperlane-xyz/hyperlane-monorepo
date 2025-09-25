import { decodeBase58, encodeBase58, hexlify } from 'ethers';

export function base58ToBuffer(value: string) {
  const decoded = decodeBase58(value);
  return Buffer.from(decoded.toString(16), 'hex');
}

export function bufferToBase58(value: Buffer) {
  return encodeBase58(value);
}

// If the value is already hex (checked by 0x prefix), return it as is.
// Otherwise, treat it as base58 and convert it to hex.
export function hexOrBase58ToHex(value: string) {
  if (value.startsWith('0x')) return value;

  return hexlify(base58ToBuffer(value));
}
