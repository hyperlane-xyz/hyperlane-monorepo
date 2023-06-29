import {
  OptimismISM__factory,
  OptimismMessageHook__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';

export const messageHookFactories = {
  optimismMessageHook: new OptimismMessageHook__factory(),
};

export const noMetadataIsmFactories = {
  optimismISM: new OptimismISM__factory(),
};

export const testRecipientFactories = {
  testRecipient: new TestRecipient__factory(),
};

export const hookFactories = {
  ...messageHookFactories,
  ...noMetadataIsmFactories,
  ...testRecipientFactories,
};

export type MessageHookFactories = typeof messageHookFactories;
export type NoMetadataIsmFactories = typeof noMetadataIsmFactories;
export type TestRecipientFactories = typeof testRecipientFactories;
export type HookFactories = Partial<MessageHookFactories> &
  Partial<NoMetadataIsmFactories> &
  Partial<TestRecipientFactories>;
