import { isNullish } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from './chainMetadataTypes.js';

// Decimal-only canonical chain IDs. Rejects hex, prefixed values, and mixed IDs
// like cosmoshub-4 so those never alias to numeric domain lookups.
const NUMERIC_CHAIN_ID_REGEX = /^\d+$/;

export function tryNormalizeNumericChainId(
  chainId: string | number,
): number | null {
  if (typeof chainId === 'number') {
    return Number.isSafeInteger(chainId) ? chainId : null;
  }

  if (!NUMERIC_CHAIN_ID_REGEX.test(chainId)) return null;

  const numericChainId = Number(chainId);
  if (!Number.isSafeInteger(numericChainId)) return null;
  if (String(numericChainId) !== chainId) return null;

  return numericChainId;
}

export function areChainIdsEqual(
  left: ChainMetadata['chainId'] | null | undefined,
  right: ChainMetadata['chainId'] | null | undefined,
): boolean {
  if (isNullish(left) || isNullish(right)) return false;

  if (left === right) return true;

  const leftNumeric = tryNormalizeNumericChainId(left);
  const rightNumeric = tryNormalizeNumericChainId(right);
  return leftNumeric !== null && leftNumeric === rightNumeric;
}

export function getEffectiveDomainId(metadata: {
  chainId: ChainMetadata['chainId'];
  domainId?: ChainMetadata['domainId'] | null;
}): number | null {
  if (!isNullish(metadata.domainId)) {
    return metadata.domainId;
  }

  return tryNormalizeNumericChainId(metadata.chainId);
}
