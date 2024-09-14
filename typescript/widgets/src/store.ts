import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMerge, objSlice } from '@hyperlane-xyz/utils';

// Increment this when persist state has breaking changes
const PERSIST_STATE_VERSION = 0;
// Key name in browser LocalStorage
const PERSIST_KEY = 'hyperlane-overrides';

// Keeping everything here for now as state is simple
// Will refactor into slices as necessary
export interface HyperlaneWidgetsState {
  chainMetadataOverrides: ChainMap<Partial<ChainMetadata>>;
  setChainMetadataOverrides: (
    overrides: ChainMap<Partial<ChainMetadata>>,
  ) => void;
  addChainMetadataOverride: (
    chainName: string,
    override: Partial<ChainMetadata>,
  ) => void;
  removeChainMetadataOverride: (
    chainName: string,
    override: Partial<ChainMetadata>,
  ) => void;
}

export const useWidgetStore = create<HyperlaneWidgetsState>()(
  persist(
    (set) => ({
      chainMetadataOverrides: {},
      setChainMetadataOverrides: (
        overrides: ChainMap<Partial<ChainMetadata>>,
      ) => {
        set(() => ({ chainMetadataOverrides: overrides }));
      },
      addChainMetadataOverride: (
        chainName: string,
        override: Partial<ChainMetadata>,
      ) => {
        set((state) => {
          const currentValues = state.chainMetadataOverrides;
          const newValues = { [chainName]: override };
          const merged = objMerge<ChainMap<Partial<ChainMetadata>>>(
            currentValues,
            newValues,
            10,
            true,
          );
          return { chainMetadataOverrides: merged };
        });
      },
      removeChainMetadataOverride: (
        chainName: string,
        override: Partial<ChainMetadata>,
      ) => {
        set((state) => {
          const currentValues = state.chainMetadataOverrides;
          const sliceValues = { [chainName]: override };
          const sliced = objSlice<ChainMap<Partial<ChainMetadata>>>(
            currentValues,
            sliceValues,
            10,
            true,
          );
          return { chainMetadataOverrides: sliced };
        });
      },
    }),
    {
      name: PERSIST_KEY,
      version: PERSIST_STATE_VERSION,
      partialize: (_state) => ({
        chainMetadataOverrides: _state.chainMetadataOverrides,
      }),
    },
  ),
);
