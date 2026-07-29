import type { Address, Hex } from 'viem';
import { isAddress, isHex } from 'viem';

import { assert } from '@hyperlane-xyz/utils';

/** Narrow a string to viem's Address (0x + 40 hex chars). Fails fast otherwise. */
export function toAddress(s: string, msg: string): Address {
  assert(isAddress(s), `${msg}: ${s}`);
  return s;
}

/** Narrow a string to viem's Hex. Fails fast otherwise. */
export function toHex(s: string, msg: string): Hex {
  assert(isHex(s), `${msg}: ${s}`);
  return s;
}
