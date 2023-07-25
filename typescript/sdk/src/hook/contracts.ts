import {
  AbstractMessageIdAuthHook__factory,
  AbstractMessageIdAuthorizedIsm__factory,
  OPStackHook__factory,
  OPStackIsm__factory,
} from '@hyperlane-xyz/core';

export type HookFactories = {
  hook: AbstractMessageIdAuthHook__factory;
  ism: AbstractMessageIdAuthorizedIsm__factory;
};

export const optimismHookFactories = {
  hook: new OPStackHook__factory(),
  ism: new OPStackIsm__factory(),
};

export type OptimismHookFactories = typeof optimismHookFactories;
