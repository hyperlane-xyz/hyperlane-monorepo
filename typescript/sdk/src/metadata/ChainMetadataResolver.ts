import { assert, isNullish } from '@hyperlane-xyz/utils';

import type { ChainMap, ChainNameOrId } from '../types.js';

import type { ChainMetadata } from './chainMetadataTypes.js';

export interface ChainMetadataResolver<MetaExt = {}> {
  metadata: ChainMap<ChainMetadata<MetaExt>>;
  getKnownChainNames: () => string[];
  tryGetChainId: (chain: ChainNameOrId) => string | number | null;
  tryGetChainMetadata: (chain: ChainNameOrId) => ChainMetadata<MetaExt> | null;
  tryGetChainName: (chain: ChainNameOrId) => string | null;
  tryGetDomainId: (chain: ChainNameOrId) => number | null;
  tryGetProtocol: (chain: ChainNameOrId) => ChainMetadata['protocol'] | null;
}

// Builds a lightweight lookup helper for one metadata snapshot without
// constructing a provider-backed registry. Numeric lookups follow SDK
// domain-id semantics; string lookups also support chain-id strings.
// Duplicate chainIds are valid across protocols/aliases, so ambiguous
// chain-id aliases are left unresolved instead of throwing.
export function createChainMetadataResolver<MetaExt = {}>(
  metadata: ChainMap<ChainMetadata<MetaExt>>,
): ChainMetadataResolver<MetaExt> {
  const byDomainId = new Map<number, ChainMetadata<MetaExt>>();
  const byChainId = new Map<string | number, ChainMetadata<MetaExt>>();
  const ambiguousChainIds = new Set<string | number>();

  const assertUniqueDomainId = (
    existing: ChainMetadata<MetaExt> | undefined,
    chainMetadata: ChainMetadata<MetaExt>,
    domainId: number,
  ) => {
    assert(
      !existing || existing.name === chainMetadata.name,
      `Duplicate domainId detected: ${String(domainId)}`,
    );
  };

  const indexChainIdAlias = (
    key: string | number,
    chainMetadata: ChainMetadata<MetaExt>,
  ) => {
    if (ambiguousChainIds.has(key)) return;

    const existing = byChainId.get(key);
    if (!existing) {
      byChainId.set(key, chainMetadata);
      return;
    }

    if (existing.name === chainMetadata.name) return;

    byChainId.delete(key);
    ambiguousChainIds.add(key);
  };

  Object.values(metadata).forEach((chainMetadata) => {
    assertUniqueDomainId(
      byDomainId.get(chainMetadata.domainId),
      chainMetadata,
      chainMetadata.domainId,
    );
    byDomainId.set(chainMetadata.domainId, chainMetadata);
    if (!isNullish(chainMetadata.chainId)) {
      indexChainIdAlias(chainMetadata.chainId, chainMetadata);

      const numericChainId = tryNormalizeNumericChainId(chainMetadata.chainId);
      if (numericChainId !== null) {
        indexChainIdAlias(numericChainId, chainMetadata);
        indexChainIdAlias(String(numericChainId), chainMetadata);
      }
    }
  });

  const tryGetChainMetadata = (chain: ChainNameOrId) => {
    if (typeof chain === 'string') {
      return metadata[chain] || byChainId.get(chain) || null;
    }
    return byChainId.get(chain) || byDomainId.get(chain) || null;
  };

  return {
    metadata,
    getKnownChainNames: () => Object.keys(metadata),
    tryGetChainId: (chain) => tryGetChainMetadata(chain)?.chainId ?? null,
    tryGetChainMetadata,
    tryGetChainName: (chain) => tryGetChainMetadata(chain)?.name ?? null,
    tryGetDomainId: (chain) => tryGetChainMetadata(chain)?.domainId ?? null,
    tryGetProtocol: (chain) => tryGetChainMetadata(chain)?.protocol ?? null,
  };
}

function tryNormalizeNumericChainId(chainId: string | number) {
  if (typeof chainId === 'number') {
    return Number.isSafeInteger(chainId) ? chainId : null;
  }

  if (!/^\d+$/.test(chainId)) return null;

  const numericChainId = Number(chainId);
  if (!Number.isSafeInteger(numericChainId)) return null;
  if (String(numericChainId) !== chainId) return null;

  return numericChainId;
}
