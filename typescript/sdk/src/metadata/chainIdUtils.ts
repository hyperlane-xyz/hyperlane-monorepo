import type { ChainMetadata } from './chainMetadataTypes.js';

export function tryNormalizeNumericChainId(
  chainId: string | number,
): number | null {
  if (typeof chainId === 'number') {
    return Number.isSafeInteger(chainId) ? chainId : null;
  }

  if (!/^\d+$/.test(chainId)) return null;

  const numericChainId = Number(chainId);
  if (!Number.isSafeInteger(numericChainId)) return null;
  if (String(numericChainId) !== chainId) return null;

  return numericChainId;
}

export function areChainIdsEqual(
  left: ChainMetadata['chainId'],
  right: ChainMetadata['chainId'],
): boolean {
  if (
    left === undefined ||
    left === null ||
    right === undefined ||
    right === null
  ) {
    return false;
  }

  if (left === right) return true;

  const leftNumeric = tryNormalizeNumericChainId(left);
  const rightNumeric = tryNormalizeNumericChainId(right);
  return leftNumeric !== null && leftNumeric === rightNumeric;
}

export function getEffectiveDomainId(
  metadata: Pick<ChainMetadata, 'chainId' | 'domainId'>,
): number | null {
  if (metadata.domainId !== undefined && metadata.domainId !== null) {
    return metadata.domainId;
  }

  return tryNormalizeNumericChainId(metadata.chainId);
}
