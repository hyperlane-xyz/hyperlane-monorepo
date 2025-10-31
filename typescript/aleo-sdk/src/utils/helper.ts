import { U128 } from '@provablehq/wasm';

import { strip0x } from '@hyperlane-xyz/utils';

export function getMessageKey(messageId: string): [U128, U128] {
  const bytes = Buffer.from(strip0x(messageId), 'hex');

  // Split into two 128-bit chunks
  const lowBytes = bytes.subarray(0, 16);
  const highBytes = bytes.subarray(16, 32);

  return [U128.fromBytesLe(lowBytes), U128.fromBytesLe(highBytes)];
}
