import bs58 from 'bs58';
import { hexlify } from 'ethers';

export function base58ToBuffer(value: string) {
  return Buffer.from(bs58.decode(value));
}

export function bufferToBase58(value: Buffer) {
  return bs58.encode(value);
}

// If the value is already hex (checked by 0x prefix), return it as is.
// Otherwise, treat it as base58 and convert it to hex.
export function hexOrBase58ToHex(value: string) {
  if (value.startsWith('0x')) return value;

  return hexlify(base58ToBuffer(value));
}
