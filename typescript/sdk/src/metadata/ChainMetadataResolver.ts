import type { ChainMap, ChainNameOrId } from '../types.js';

import type { ChainMetadata } from './chainMetadataTypes.js';

export interface ChainMetadataResolver<MetaExt = {}> {
  metadata: ChainMap<ChainMetadata<MetaExt>>;
  getKnownChainNames: () => string[];
  tryGetChainId: (chain: ChainNameOrId) => string | number | null;
  tryGetChainMetadata: (
    chain: ChainNameOrId,
  ) => ChainMetadata<MetaExt> | null | undefined;
  tryGetChainName: (chain: ChainNameOrId) => string | null;
  tryGetDomainId: (chainName: string) => number | null;
  tryGetProtocol: (chain: ChainNameOrId) => ChainMetadata['protocol'] | null;
}

// Builds a lightweight lookup helper for one metadata snapshot without
// constructing a provider-backed registry. Numeric lookups follow SDK
// domain-id semantics; string lookups also support chain-id strings.
export function createChainMetadataResolver<MetaExt = {}>(
  metadata: ChainMap<ChainMetadata<MetaExt>>,
): ChainMetadataResolver<MetaExt> {
  const byDomainId = new Map<number, ChainMetadata<MetaExt>>();
  const byChainId = new Map<string | number, ChainMetadata<MetaExt>>();

  Object.values(metadata).forEach((chainMetadata) => {
    byDomainId.set(chainMetadata.domainId, chainMetadata);
    if (chainMetadata.chainId !== undefined && chainMetadata.chainId !== null) {
      byChainId.set(chainMetadata.chainId, chainMetadata);

      const numericChainId = tryNormalizeNumericChainId(chainMetadata.chainId);
      if (numericChainId !== null) {
        byChainId.set(numericChainId, chainMetadata);
        byChainId.set(String(numericChainId), chainMetadata);
      }
    }
  });

  const tryGetChainMetadata = (chain: ChainNameOrId) => {
    if (typeof chain === 'string') {
      return metadata[chain] || byChainId.get(chain) || null;
    }
    return byDomainId.get(chain) || byChainId.get(chain) || null;
  };

  return {
    metadata,
    getKnownChainNames: () => Object.keys(metadata),
    tryGetChainId: (chain) => tryGetChainMetadata(chain)?.chainId ?? null,
    tryGetChainMetadata,
    tryGetChainName: (chain) => tryGetChainMetadata(chain)?.name ?? null,
    tryGetDomainId: (chainName) => metadata[chainName]?.domainId ?? null,
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
