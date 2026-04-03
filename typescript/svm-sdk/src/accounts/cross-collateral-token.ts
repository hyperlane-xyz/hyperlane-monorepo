import { decodeAccountData } from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import { decodeMapU32SetH256 } from '../codecs/shared.js';

export interface CrossCollateralStateData {
  bump: number;
  dispatchAuthorityBump: number;
  localDomain: number;
  enrolledRouters: Map<number, Uint8Array[]>;
}

export function decodeCrossCollateralStateAccount(
  raw: Uint8Array,
): CrossCollateralStateData | null {
  const wrapped = decodeAccountData(raw, decodeCrossCollateralStateInner);
  return wrapped.data;
}

function decodeCrossCollateralStateInner(
  cursor: ByteCursor,
): CrossCollateralStateData {
  const bump = cursor.readU8();
  const dispatchAuthorityBump = cursor.readU8();
  const localDomain = cursor.readU32LE();
  const enrolledRouters = decodeMapU32SetH256(cursor);
  return { bump, dispatchAuthorityBump, localDomain, enrolledRouters };
}
