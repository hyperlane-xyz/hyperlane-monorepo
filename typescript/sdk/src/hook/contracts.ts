import {
  OPStackHook__factory,
  OPStackIsm__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';

export const optimismMessageHookFactories = {
  optimismMessageHook: new OPStackHook__factory(),
};

export const optimismIsmFactories = {
  optimismISM: new OPStackIsm__factory(),
};

export const testRecipientFactories = {
  testRecipient: new TestRecipient__factory(),
};

export const hookFactories = {
  ...optimismMessageHookFactories,
  ...optimismIsmFactories,
  ...testRecipientFactories,
};

export type MessageHookFactories = typeof optimismMessageHookFactories;
export type NoMetadataIsmFactories = typeof optimismIsmFactories;
export type TestRecipientFactories = typeof testRecipientFactories;
export type HookFactories = Partial<MessageHookFactories> &
  Partial<NoMetadataIsmFactories> &
  Partial<TestRecipientFactories>;
