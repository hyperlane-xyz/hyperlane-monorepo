import { ethers } from 'ethers';

import { strip0x } from '@hyperlane-xyz/utils';

/**
 * Returns the lowercase hex (without 0x) of the address a `matchBody: true`
 * rule scans message bodies for. Like the relayer, only 20-byte EVM hex
 * addresses may opt in.
 */
export function parseMatchBodyAddress(
  address: string,
  matchBody: boolean | undefined,
): string | undefined {
  if (matchBody !== true) return undefined;

  const trimmed = address.trim();
  if (!ethers.utils.isHexString(trimmed, 20)) {
    throw new Error('`matchBody` requires a 20-byte EVM hex address');
  }

  return strip0x(trimmed).toLowerCase();
}

/**
 * Whether the message body contains the address at any byte boundary, like
 * the relayer's `body.windows(20)` scan.
 */
export function bodyContainsAddress(
  messageBody: string,
  addressHex: string,
): boolean {
  const body = strip0x(messageBody).toLowerCase();

  for (
    let index = body.indexOf(addressHex);
    index !== -1;
    index = body.indexOf(addressHex, index + 1)
  ) {
    if (index % 2 === 0) return true;
  }

  return false;
}
