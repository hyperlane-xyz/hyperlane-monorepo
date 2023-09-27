import { OPStackHook__factory, OPStackIsm__factory } from '@hyperlane-xyz/core';

export const opStackHookFactories = {
  opStackHook: new OPStackHook__factory(),
};
export type OpStackHookFactories = typeof opStackHookFactories;

export const opStackIsmFactories = {
  opStackIsm: new OPStackIsm__factory(),
};

export type OpStackIsmFactories = typeof opStackIsmFactories;

export type OpStackInterceptorFactories =
  | OpStackHookFactories
  | OpStackIsmFactories;
