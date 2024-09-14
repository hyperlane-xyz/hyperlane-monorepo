import { useMemo } from 'react';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import { useWidgetStore } from '../store.js';

// Use the provided chain metadata but with any overrides in the store/storage merged in
export function useMergedChainMetadata(chainMetadata: ChainMetadata) {
  const overrideChainMetadata =
    useWidgetStore((state) => state.chainMetadataOverrides)[
      chainMetadata.name
    ] || {};
  const mergedChainMetadata = useMemo(
    () =>
      objMerge<ChainMetadata>(
        chainMetadata,
        overrideChainMetadata || {},
        10,
        true,
      ),
    [chainMetadata, overrideChainMetadata],
  );
  return { mergedChainMetadata, overrideChainMetadata };
}

// Same as above but for a whole ChainMap instead of one chain
export function useMergedChainMetadataMap(
  chainMetadataMap: ChainMap<ChainMetadata>,
) {
  const overrideChainMetadata = useWidgetStore(
    (state) => state.chainMetadataOverrides,
  );
  const mergedChainMetadata = useMemo(
    () =>
      objMerge<ChainMetadata>(
        chainMetadataMap,
        overrideChainMetadata || {},
        10,
        true,
      ),
    [chainMetadataMap, overrideChainMetadata],
  );
  return { mergedChainMetadata, overrideChainMetadata };
}
