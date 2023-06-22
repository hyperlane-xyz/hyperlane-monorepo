import {
  OptimismISM__factory,
  OptimismMessageHook__factory,
} from '@hyperlane-xyz/core';

export const messageHookFactories = {
  optimismMessageHook: new OptimismMessageHook__factory(),
};

export const noMetadataIsmFactories = {
  optimismISM: new OptimismISM__factory(),
};

export type MessageHookFactories = typeof messageHookFactories;
export type NoMetadataIsmFactories = typeof noMetadataIsmFactories;
