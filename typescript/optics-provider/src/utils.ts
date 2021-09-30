import { arrayify, BytesLike, hexlify } from '@ethersproject/bytes';
import { ethers } from 'ethers';

export type Address = string;

// ensure that a bytes-like is 32 long. left-pad with 0s if not
export function canonizeId(data: BytesLike): Uint8Array {
  const buf = ethers.utils.arrayify(data);
  if (buf.length > 32) {
    throw new Error('Too long');
  }
  if (buf.length !== 20 && buf.length != 32) {
    throw new Error('bad input, expect address or bytes32');
  }
  return ethers.utils.zeroPad(buf, 32);
}

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

// sleep
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
