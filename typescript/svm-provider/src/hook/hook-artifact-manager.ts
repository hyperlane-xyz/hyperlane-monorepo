import { decodeHookAccount } from './hook-query.js';

export type HookAccountDecoder = keyof typeof decodeHookAccount;

export function detectHookAccountDecoder(
  kind: HookAccountDecoder,
  raw: Uint8Array,
) {
  return decodeHookAccount[kind](raw);
}
