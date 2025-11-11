import { U128 } from '@provablehq/wasm';

import { strip0x } from '@hyperlane-xyz/utils';

export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';

export function getMessageKey(messageId: string): [U128, U128] {
  const bytes = Buffer.from(strip0x(messageId), 'hex');

  // Split into two 128-bit chunks
  const lowBytes = Uint8Array.from(bytes.subarray(0, 16));
  const highBytes = Uint8Array.from(bytes.subarray(16, 32));

  return [U128.fromBytesLe(lowBytes), U128.fromBytesLe(highBytes)];
}

export function formatAddress(address: string): string {
  return address === ALEO_NULL_ADDRESS ? '' : address;
}

export function stringToU128(input: string): U128 {
  if (input.length > 16) {
    throw new Error(`string "${input}" is too long to convert it into U128`);
  }

  const encoded = new TextEncoder().encode(input);
  const bytes = new Uint8Array(16);
  bytes.set(encoded.subarray(0, 16));

  return U128.fromBytesLe(bytes);
}

export function U128ToString(input: U128): string {
  return new TextDecoder().decode(input.toBytesLe().filter((b) => b > 0));
}
