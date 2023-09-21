import { HookContractType, PostDispatchHookConfig } from './types';

export const isHookConfig = (
  config: PostDispatchHookConfig,
): config is PostDispatchHookConfig =>
  config.hookContractType === HookContractType.HOOK;
